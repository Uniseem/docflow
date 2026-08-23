import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.api import admin_login, admin_status, register_admin
from app.database import Base
from app.models import AdminUser
from app.schemas import LoginRequest, RegisterRequest


def _engine():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    return engine


def test_first_registration_claims_the_only_admin_slot() -> None:
    engine = _engine()
    with Session(engine) as db:
        assert admin_status(db).initialized is False
        response = register_admin(RegisterRequest(username="owner", password="a-strong-password"), db)
        assert response.token
        assert admin_status(db).initialized is True
        admin = db.get(AdminUser, 1)
        assert admin is not None
        assert admin.username == "owner"
        assert admin.password_hash != "a-strong-password"

        with pytest.raises(HTTPException) as conflict:
            register_admin(RegisterRequest(username="second", password="another-password"), db)
        assert conflict.value.status_code == 409


def test_registered_admin_can_log_in() -> None:
    engine = _engine()
    with Session(engine) as db:
        register_admin(RegisterRequest(username="站长", password="a-strong-password"), db)
        assert admin_login(LoginRequest(username="站长", password="a-strong-password"), db).token

        with pytest.raises(HTTPException) as unauthorized:
            admin_login(LoginRequest(username="站长", password="wrong-password"), db)
        assert unauthorized.value.status_code == 401

