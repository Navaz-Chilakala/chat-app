import hashlib
import json
import re
import secrets
from datetime import timedelta
from functools import wraps
from hmac import compare_digest

from django.conf import settings
from django.db import transaction
from django.db.models import F
from django.http import JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from .cleanup import next_purge_at, purge_stale, to_ms
from .models import ChatSession, Message

ROOM_ID_RE = re.compile(r"^[0-9a-f]{64}$")
BASE64_RE = re.compile(r"^[A-Za-z0-9+/]+={0,2}$")


def error(message, status):
    return JsonResponse({"error": message}, status=status)


def hash_token(token):
    return hashlib.sha256(token.encode()).hexdigest()


def read_json(request):
    try:
        body = json.loads(request.body or b"{}")
    except (ValueError, UnicodeDecodeError):
        return None
    return body if isinstance(body, dict) else None


def bearer_token(request):
    header = request.headers.get("Authorization", "")
    return header[7:].strip() if header.startswith("Bearer ") else ""


def with_cleanup(view):
    """Lazily wipe yesterday's messages and expired sessions before every call."""

    @wraps(view)
    def wrapper(request, *args, **kwargs):
        purge_stale()
        return view(request, *args, **kwargs)

    return wrapper


def require_chat_session(view):
    @wraps(view)
    def wrapper(request, *args, **kwargs):
        token = bearer_token(request)
        session = None
        if token:
            session = ChatSession.objects.filter(
                token_hash=hash_token(token), expires_at__gt=timezone.now()
            ).first()
        if session is None:
            return error("session expired", 401)
        return view(request, session, *args, **kwargs)

    return wrapper


def session_info(session):
    return {
        "expires_at": to_ms(session.expires_at),
        "purge_at": to_ms(next_purge_at()),
        "online": ChatSession.objects.filter(
            room_id=session.room_id, expires_at__gt=timezone.now()
        ).count(),
    }


@csrf_exempt
@require_http_methods(["POST", "DELETE"])
@with_cleanup
def session_view(request):
    if request.method == "DELETE":
        token = bearer_token(request)
        if token:
            ChatSession.objects.filter(token_hash=hash_token(token)).delete()
        return JsonResponse({"ok": True})

    body = read_json(request)
    room_id = body.get("room") if body else None
    if not isinstance(room_id, str) or not ROOM_ID_RE.match(room_id):
        return error("invalid room", 400)

    now = timezone.now()
    with transaction.atomic():
        active = ChatSession.objects.filter(room_id=room_id, expires_at__gt=now).count()
        if active >= settings.CHAT_MAX_SESSIONS_PER_ROOM:
            return error("room full", 429)
        token = secrets.token_urlsafe(32)
        session = ChatSession.objects.create(
            token_hash=hash_token(token),
            room_id=room_id,
            expires_at=now + timedelta(seconds=settings.CHAT_SESSION_SECONDS),
        )
    return JsonResponse({"token": token, **session_info(session)}, status=201)


@csrf_exempt
@require_http_methods(["GET", "POST"])
@with_cleanup
@require_chat_session
def messages_view(request, session):
    if request.method == "GET":
        try:
            after = max(0, int(request.GET.get("after", "0")))
        except ValueError:
            return error("invalid cursor", 400)
        qs = Message.objects.filter(room_id=session.room_id, id__gt=after).order_by("-id")
        rows = list(qs.values_list("id", "ciphertext")[: settings.CHAT_HISTORY_LIMIT])
        rows.reverse()
        return JsonResponse(
            {"messages": [{"id": i, "data": c} for i, c in rows], **session_info(session)}
        )

    body = read_json(request)
    data = body.get("data") if body else None
    if (
        not isinstance(data, str)
        or not data
        or len(data) > settings.CHAT_MAX_MESSAGE_CHARS
        or not BASE64_RE.match(data)
    ):
        return error("invalid message", 400)

    updated = ChatSession.objects.filter(
        pk=session.pk, message_count__lt=settings.CHAT_MAX_MESSAGES_PER_SESSION
    ).update(message_count=F("message_count") + 1)
    if not updated:
        return error("message limit reached for this session", 429)

    msg = Message.objects.create(room_id=session.room_id, ciphertext=data)
    return JsonResponse({"id": msg.id}, status=201)


@csrf_exempt
@require_http_methods(["GET", "POST"])
def purge_view(request):
    """Daily purge hook for Vercel Cron (or any scheduler).

    Vercel sends `Authorization: Bearer $CRON_SECRET`. Also safe to call more often:
    it only removes messages from before today (UTC) and expired sessions.
    """
    expected = settings.CRON_SECRET
    if not expected or not compare_digest(bearer_token(request), expected):
        return error("forbidden", 403)
    purge_stale()
    return JsonResponse({"ok": True})


def health_view(request):
    return JsonResponse({"ok": True})
