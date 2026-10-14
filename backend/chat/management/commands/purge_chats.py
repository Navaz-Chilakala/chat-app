from django.core.management.base import BaseCommand

from chat.cleanup import purge_stale


class Command(BaseCommand):
    help = "Delete messages from before today (UTC) and expired chat sessions."

    def handle(self, *args, **options):
        purge_stale()
        self.stdout.write("Purged.")
