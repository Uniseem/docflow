from celery import Celery

from .config import get_settings


settings = get_settings()
celery = Celery("docflow", broker=settings.redis_url, backend=settings.redis_url, include=["app.tasks"])
celery.conf.update(
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,
    broker_transport_options={"visibility_timeout": 86_400},
    result_expires=86_400,
    timezone="Asia/Shanghai",
    enable_utc=True,
)

