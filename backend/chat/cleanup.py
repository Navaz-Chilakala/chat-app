from datetime import datetime, timedelta, timezone

from django.utils import timezone as dj_timezone

from .models import ChatSession, Message


def start_of_today_utc(now=None):
    now = now or dj_timezone.now()
    return now.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)


def next_purge_at(now=None):
    return start_of_today_utc(now) + timedelta(days=1)


def purge_stale(now=None):
    """Delete every message from before today (UTC) and every expired session.

    Serverless platforms have no background workers, so this runs at the start
    of every API request as well as from the daily cron endpoint. That way chats
    are gone after midnight UTC even if the cron never fires.
    """
    now = now or dj_timezone.now()
    Message.objects.filter(created_at__lt=start_of_today_utc(now)).delete()
    ChatSession.objects.filter(expires_at__lte=now).delete()


def to_ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)
