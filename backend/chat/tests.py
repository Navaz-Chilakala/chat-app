import json
from datetime import timedelta
from unittest import mock

from django.test import TestCase, override_settings
from django.utils import timezone

from .cleanup import purge_stale
from .models import ChatSession, Message

ROOM = "a" * 64
OTHER_ROOM = "b" * 64


class ChatApiTests(TestCase):
    def join(self, room=ROOM):
        res = self.client.post("/api/session", json.dumps({"room": room}), content_type="application/json")
        self.assertEqual(res.status_code, 201)
        return res.json()["token"]

    def auth(self, token):
        return {"HTTP_AUTHORIZATION": f"Bearer {token}"}

    def post_msg(self, token, data="aGVsbG8="):
        return self.client.post(
            "/api/messages", json.dumps({"data": data}), content_type="application/json", **self.auth(token)
        )

    def test_join_returns_ten_minute_session_and_stores_only_token_hash(self):
        res = self.client.post("/api/session", json.dumps({"room": ROOM}), content_type="application/json")
        body = res.json()
        session = ChatSession.objects.get()
        self.assertNotEqual(session.token_hash, body["token"])
        remaining = body["expires_at"] / 1000 - timezone.now().timestamp()
        self.assertAlmostEqual(remaining, 600, delta=5)
        self.assertEqual(body["online"], 1)

    def test_rejects_invalid_room(self):
        res = self.client.post("/api/session", json.dumps({"room": "not-a-hash"}), content_type="application/json")
        self.assertEqual(res.status_code, 400)

    def test_messages_are_scoped_to_room_and_paginated(self):
        a = self.join()
        b = self.join(OTHER_ROOM)
        self.assertEqual(self.post_msg(a, "Zmlyc3Q=").status_code, 201)
        second_id = self.post_msg(a, "c2Vjb25k").json()["id"]
        self.post_msg(b, "b3RoZXI=")

        res = self.client.get("/api/messages", **self.auth(a)).json()
        self.assertEqual([m["data"] for m in res["messages"]], ["Zmlyc3Q=", "c2Vjb25k"])
        res = self.client.get(f"/api/messages?after={second_id}", **self.auth(a)).json()
        self.assertEqual(res["messages"], [])

    def test_rejects_non_base64_payload(self):
        token = self.join()
        self.assertEqual(self.post_msg(token, "<script>").status_code, 400)

    def test_requires_valid_session(self):
        self.assertEqual(self.client.get("/api/messages").status_code, 401)
        self.assertEqual(self.client.get("/api/messages", **self.auth("bogus")).status_code, 401)

    def test_session_expires_after_ten_minutes(self):
        token = self.join()
        later = timezone.now() + timedelta(minutes=10, seconds=1)
        with mock.patch("django.utils.timezone.now", return_value=later):
            self.assertEqual(self.client.get("/api/messages", **self.auth(token)).status_code, 401)
        self.assertFalse(ChatSession.objects.exists())

    def test_leave_deletes_session(self):
        token = self.join()
        self.client.delete("/api/session", **self.auth(token))
        self.assertEqual(self.client.get("/api/messages", **self.auth(token)).status_code, 401)

    def test_message_limit_per_session(self):
        token = self.join()
        with self.settings(CHAT_MAX_MESSAGES_PER_SESSION=2):
            self.assertEqual(self.post_msg(token).status_code, 201)
            self.assertEqual(self.post_msg(token).status_code, 201)
            self.assertEqual(self.post_msg(token).status_code, 429)

    def test_yesterdays_messages_are_purged(self):
        token = self.join()
        self.post_msg(token)
        old = Message.objects.create(room_id=ROOM, ciphertext="b2xk")
        Message.objects.filter(pk=old.pk).update(created_at=timezone.now() - timedelta(days=1))

        res = self.client.get("/api/messages", **self.auth(token)).json()
        self.assertEqual(len(res["messages"]), 1)
        self.assertFalse(Message.objects.filter(pk=old.pk).exists())

    def test_purge_after_midnight_removes_everything_from_previous_day(self):
        token = self.join()
        self.post_msg(token)
        purge_stale(now=timezone.now() + timedelta(days=1))
        self.assertFalse(Message.objects.exists())
        self.assertFalse(ChatSession.objects.exists())

    @override_settings(CRON_SECRET="s3cret")
    def test_purge_endpoint_requires_secret(self):
        self.assertEqual(self.client.get("/api/purge").status_code, 403)
        self.assertEqual(self.client.get("/api/purge", **self.auth("wrong")).status_code, 403)
        self.assertEqual(self.client.get("/api/purge", **self.auth("s3cret")).status_code, 200)

    def test_responses_are_not_cached(self):
        res = self.client.get("/api/health")
        self.assertEqual(res["Cache-Control"], "no-store")
