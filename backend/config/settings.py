"""
Django settings for the ephemeral chat backend.

Everything privacy-related is deliberately minimal: no admin, no auth, no
sessions/cookies, no request logging. The server only ever stores opaque room
ids, hashed session tokens and ciphertext.
"""

import os
from pathlib import Path

import dj_database_url

BASE_DIR = Path(__file__).resolve().parent.parent

ON_VERCEL = bool(os.environ.get("VERCEL"))

DEBUG = os.environ.get("DJANGO_DEBUG", "0" if ON_VERCEL else "1") == "1"

SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY")
if not SECRET_KEY:
    if not DEBUG:
        raise RuntimeError("DJANGO_SECRET_KEY must be set when DEBUG is off")
    SECRET_KEY = "dev-only-insecure-key"

ALLOWED_HOSTS = [
    h.strip()
    for h in os.environ.get("DJANGO_ALLOWED_HOSTS", ".vercel.app,localhost,127.0.0.1").split(",")
    if h.strip()
]

INSTALLED_APPS = [
    "corsheaders",
    "chat",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.common.CommonMiddleware",
    "chat.middleware.NoTraceMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"

# Database
# - DATABASE_URL set (e.g. Neon / Vercel Postgres / Supabase): use it. Required for
#   a real deployment, because serverless instances do not share a filesystem.
# - Otherwise: Django's built-in SQLite. Locally that is backend/db.sqlite3; on
#   Vercel it falls back to /tmp, which works for a demo but is per-instance and
#   is lost whenever the instance is recycled.
DATABASE_URL = os.environ.get("DATABASE_URL")
if DATABASE_URL:
    DATABASES = {"default": dj_database_url.parse(DATABASE_URL, conn_max_age=0, ssl_require=not DEBUG)}
else:
    sqlite_path = "/tmp/ephemeral-chat.sqlite3" if ON_VERCEL else BASE_DIR / "db.sqlite3"
    DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": sqlite_path}}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

USE_TZ = True
TIME_ZONE = "UTC"
USE_I18N = False

# CORS: only needed when the React app is served from a different origin than
# the API (e.g. frontend on Netlify, backend on Vercel). No cookies are used.
CORS_ALLOWED_ORIGINS = [
    o.strip() for o in os.environ.get("CORS_ALLOWED_ORIGINS", "").split(",") if o.strip()
]
if DEBUG:
    CORS_ALLOWED_ORIGINS += ["http://localhost:5173", "http://127.0.0.1:5173"]
CORS_ALLOW_HEADERS = ["authorization", "content-type"]
CORS_ALLOW_CREDENTIALS = False

# Security headers
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "no-referrer"
X_FRAME_OPTIONS = "DENY"
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

# Chat behaviour
CHAT_SESSION_SECONDS = int(os.environ.get("CHAT_SESSION_SECONDS", 10 * 60))
CHAT_MAX_MESSAGE_CHARS = 16 * 1024
CHAT_MAX_MESSAGES_PER_SESSION = 300
CHAT_MAX_SESSIONS_PER_ROOM = 50
CHAT_HISTORY_LIMIT = 200
# Shared secret for the daily purge endpoint (Vercel Cron sends it as a Bearer token).
CRON_SECRET = os.environ.get("CRON_SECRET", "")

# No request logging: silence Django's request/server loggers so nothing about
# who called what ends up in logs. Errors still go to stderr without request data.
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"null": {"class": "logging.NullHandler"}},
    "loggers": {
        "django.request": {"handlers": ["null"], "propagate": False},
        "django.server": {"handlers": ["null"], "propagate": False},
        "django.security": {"handlers": ["null"], "propagate": False},
    },
}
