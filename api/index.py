"""Vercel Python entrypoint: serves the Django API at /api/*."""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

import django  # noqa: E402

django.setup()

from django.conf import settings  # noqa: E402
from django.core.management import call_command  # noqa: E402
from django.core.wsgi import get_wsgi_application  # noqa: E402

# Without DATABASE_URL each serverless instance gets a fresh SQLite file in /tmp,
# so its tables have to be created on cold start. With a real database, run
# migrations yourself (or set AUTO_MIGRATE=1).
if not os.environ.get("DATABASE_URL") or os.environ.get("AUTO_MIGRATE") == "1":
    call_command("migrate", interactive=False, verbosity=0)

app = get_wsgi_application()
