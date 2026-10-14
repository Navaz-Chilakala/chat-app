from django.urls import path

from chat import views

urlpatterns = [
    path("api/health", views.health_view),
    path("api/session", views.session_view),
    path("api/messages", views.messages_view),
    path("api/purge", views.purge_view),
]
