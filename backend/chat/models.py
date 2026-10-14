from django.db import models


class ChatSession(models.Model):
    """A 10-minute pass to read/write one room.

    Only a SHA-256 hash of the bearer token is stored, and nothing about the
    person (no username, IP or user agent). The username lives inside the
    encrypted messages.
    """

    token_hash = models.CharField(max_length=64, primary_key=True)
    room_id = models.CharField(max_length=64, db_index=True)
    expires_at = models.DateTimeField(db_index=True)
    message_count = models.PositiveIntegerField(default=0)


class Message(models.Model):
    """An end-to-end encrypted message. The server cannot read `ciphertext`.

    Messages are deliberately not linked to the session that sent them.
    """

    room_id = models.CharField(max_length=64)
    ciphertext = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        indexes = [models.Index(fields=["room_id", "id"])]
