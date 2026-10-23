"""Database records.

Model versions, simulation runs and reports are append-only: a change to a
business model creates a new ModelVersion, and runs/reports keep the id of the
version that produced them, so historical results are never rewritten.
"""
from __future__ import annotations

from datetime import date, datetime, timezone

from sqlalchemy import JSON, Boolean, Date, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import TypeDecorator

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class UTCDateTime(TypeDecorator):
    """Stores UTC and always returns timezone-aware UTC datetimes.

    SQLite drops timezone information, so values read back are naive; without
    this, the browser would read a UTC time as local time.
    """
    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is not None and value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc) if value is not None else None

    def process_result_value(self, value, dialect):
        if value is not None and value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value


class Workspace(Base):
    """An anonymous workspace owned by one browser (see app/auth.py).

    The table keeps its original name and columns from when What-if had
    accounts, so existing data survives the switch. For anonymous workspaces
    `email` is a random placeholder and `password_hash` is unusable ("!").
    """
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class Business(Base):
    __tablename__ = "businesses"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(160))
    industry: Mapped[str] = mapped_column(String(40), default="retail")
    business_type: Mapped[str] = mapped_column(String(80), default="general retail")
    description: Mapped[str] = mapped_column(Text, default="")
    decision: Mapped[str] = mapped_column(Text, default="")
    creation_mode: Mapped[str] = mapped_column(String(10), default="build")  # build | plan
    plan: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    plan_status: Mapped[str] = mapped_column(String(20), default="none")  # none | draft | approved
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)
    active_model_version_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, onupdate=utcnow)

    versions: Mapped[list[ModelVersion]] = relationship(back_populates="business", cascade="all, delete-orphan")


class ModelVersion(Base):
    __tablename__ = "model_versions"
    id: Mapped[int] = mapped_column(primary_key=True)
    business_id: Mapped[int] = mapped_column(ForeignKey("businesses.id", ondelete="CASCADE"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    spec: Mapped[dict] = mapped_column(JSON)
    validation: Mapped[dict] = mapped_column(JSON, default=dict)
    calibration: Mapped[str] = mapped_column(String(20), default="exploratory")  # invalid | exploratory | calibrated
    change_note: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[str] = mapped_column(String(60), default="user")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)

    business: Mapped[Business] = relationship(back_populates="versions")


class DataSource(Base):
    __tablename__ = "data_sources"
    id: Mapped[int] = mapped_column(primary_key=True)
    business_id: Mapped[int] = mapped_column(ForeignKey("businesses.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(20))  # products | sales | expenses
    filename: Mapped[str] = mapped_column(String(255))
    row_count: Mapped[int] = mapped_column(Integer, default=0)
    report: Mapped[dict] = mapped_column(JSON, default=dict)
    parsed: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(20), default="reviewed")  # reviewed | applied | rejected
    applied_version_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    uploaded_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class Scenario(Base):
    __tablename__ = "scenarios"
    id: Mapped[int] = mapped_column(primary_key=True)
    business_id: Mapped[int] = mapped_column(ForeignKey("businesses.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    decision: Mapped[str] = mapped_column(Text, default="")
    kind: Mapped[str] = mapped_column(String(30), default="custom")  # baseline | inventory | delivery | price | stress | staffing | custom
    color_index: Mapped[int] = mapped_column(Integer, default=0)
    is_baseline: Mapped[bool] = mapped_column(Boolean, default=False)
    base_model_version_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    levers: Mapped[dict] = mapped_column(JSON, default=dict)
    assumptions: Mapped[list] = mapped_column(JSON, default=list)
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    success_criteria: Mapped[dict] = mapped_column(JSON, default=dict)
    origin: Mapped[str] = mapped_column(String(60), default="user")
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, onupdate=utcnow)


class SimulationRun(Base):
    __tablename__ = "simulation_runs"
    id: Mapped[int] = mapped_column(primary_key=True)
    business_id: Mapped[int] = mapped_column(ForeignKey("businesses.id", ondelete="CASCADE"), index=True)
    scenario_id: Mapped[int | None] = mapped_column(ForeignKey("scenarios.id", ondelete="SET NULL"), nullable=True, index=True)
    model_version_id: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(20), default="scenario")  # scenario | stress | sensitivity
    parent_run_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    scenario_name: Mapped[str] = mapped_column(String(120), default="")
    color_index: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(30), default="queued")
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    stage: Mapped[str] = mapped_column(String(120), default="")
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    levers: Mapped[dict] = mapped_column(JSON, default=dict)
    levers_hash: Mapped[str] = mapped_column(String(64), default="")
    criteria: Mapped[dict] = mapped_column(JSON, default=dict)
    inputs: Mapped[dict] = mapped_column(JSON, default=dict)
    results: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    warnings: Mapped[list] = mapped_column(JSON, default=list)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    outcome: Mapped[str | None] = mapped_column(String(30), nullable=True)  # passed | failed_constraints
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class Report(Base):
    __tablename__ = "reports"
    id: Mapped[int] = mapped_column(primary_key=True)
    business_id: Mapped[int] = mapped_column(ForeignKey("businesses.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    run_ids: Mapped[list] = mapped_column(JSON, default=list)
    model_version_ids: Mapped[list] = mapped_column(JSON, default=list)
    content: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class FailureRecord(Base):
    __tablename__ = "failure_records"
    id: Mapped[int] = mapped_column(primary_key=True)
    business_id: Mapped[int] = mapped_column(ForeignKey("businesses.id", ondelete="CASCADE"), index=True)
    run_id: Mapped[int] = mapped_column(Integer, index=True)
    scenario_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    title: Mapped[str] = mapped_column(String(200))
    category: Mapped[str] = mapped_column(String(20), default="failed")  # failed | rejected
    tested: Mapped[str] = mapped_column(Text, default="")
    reasons: Mapped[list] = mapped_column(JSON, default=list)
    limits_exceeded: Mapped[list] = mapped_column(JSON, default=list)
    contributing_assumptions: Mapped[list] = mapped_column(JSON, default=list)
    lessons: Mapped[str] = mapped_column(Text, default="")
    next_changes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class FeedbackObservation(Base):
    __tablename__ = "feedback_observations"
    id: Mapped[int] = mapped_column(primary_key=True)
    business_id: Mapped[int] = mapped_column(ForeignKey("businesses.id", ondelete="CASCADE"), index=True)
    run_id: Mapped[int] = mapped_column(Integer, index=True)
    period_start: Mapped[date] = mapped_column(Date)
    period_end: Mapped[date] = mapped_column(Date)
    actual: Mapped[dict] = mapped_column(JSON, default=dict)
    comparison: Mapped[dict] = mapped_column(JSON, default=dict)
    notes: Mapped[str] = mapped_column(Text, default="")
    calibration_status: Mapped[str] = mapped_column(String(20), default="pending")  # pending | applied | dismissed | not_applicable
    applied_version_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class AuditEvent(Base):
    __tablename__ = "audit_events"
    id: Mapped[int] = mapped_column(primary_key=True)
    business_id: Mapped[int | None] = mapped_column(Integer, index=True, nullable=True)
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    actor: Mapped[str] = mapped_column(String(60))  # user | engine | agent:<name>
    action: Mapped[str] = mapped_column(String(80))
    summary: Mapped[str] = mapped_column(Text, default="")
    detail: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class ResearchBrief(Base):
    """Public data gathered for one business at one time (see app/research.py).

    Kept as retrieved, with source URLs and retrieval times, so later reports
    can show exactly what was known when a scenario was created from it.
    """
    __tablename__ = "research_briefs"
    id: Mapped[int] = mapped_column(primary_key=True)
    business_id: Mapped[int] = mapped_column(ForeignKey("businesses.id", ondelete="CASCADE"), index=True)
    country: Mapped[str] = mapped_column(String(2))
    params: Mapped[dict] = mapped_column(JSON, default=dict)
    content: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


# ---------------------------------------------------------------- What-if
# Profiles are append-only like ModelVersion: saving a profile creates a new
# version, and every scenario keeps the id of the version it was calculated on.

class WhatIfProfile(Base):
    __tablename__ = "wi_profiles"
    id: Mapped[int] = mapped_column(primary_key=True)
    business_id: Mapped[int] = mapped_column(ForeignKey("businesses.id", ondelete="CASCADE"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    spec: Mapped[dict] = mapped_column(JSON)
    validation: Mapped[dict] = mapped_column(JSON, default=dict)
    note: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[str] = mapped_column(String(60), default="user")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class WhatIfScenario(Base):
    __tablename__ = "wi_scenarios"
    id: Mapped[int] = mapped_column(primary_key=True)
    business_id: Mapped[int] = mapped_column(ForeignKey("businesses.id", ondelete="CASCADE"), index=True)
    profile_id: Mapped[int] = mapped_column(Integer)
    name: Mapped[str] = mapped_column(String(160))
    question: Mapped[str] = mapped_column(Text, default="")
    levers: Mapped[dict] = mapped_column(JSON, default=dict)
    interpretation: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    result: Mapped[dict] = mapped_column(JSON, default=dict)
    risks: Mapped[dict] = mapped_column(JSON, default=dict)
    explanation: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    origin: Mapped[str] = mapped_column(String(60), default="user")
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, onupdate=utcnow)


class WhatIfReport(Base):
    __tablename__ = "wi_reports"
    id: Mapped[int] = mapped_column(primary_key=True)
    business_id: Mapped[int] = mapped_column(ForeignKey("businesses.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    scenario_ids: Mapped[list] = mapped_column(JSON, default=list)
    content: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class WhatIfSignal(Base):
    """One retrieval of one external signal, kept as retrieved (or as failed)."""
    __tablename__ = "wi_signals"
    id: Mapped[int] = mapped_column(primary_key=True)
    business_id: Mapped[int] = mapped_column(ForeignKey("businesses.id", ondelete="CASCADE"), index=True)
    key: Mapped[str] = mapped_column(String(30))
    status: Mapped[str] = mapped_column(String(20))
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    retrieved_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class WhatIfRiskAssessment(Base):
    """A Risk Radar assessment (AI or rule-based) and the key of the inputs it was written for.

    A later request with the same key reuses it instead of calling the AI again; a different key
    (figures, levers, period or external data changed) marks it as outdated.
    """
    __tablename__ = "wi_risk_assessments"
    id: Mapped[int] = mapped_column(primary_key=True)
    business_id: Mapped[int] = mapped_column(ForeignKey("businesses.id", ondelete="CASCADE"), index=True)
    scope: Mapped[str] = mapped_column(String(40))  # "baseline" or "scenario:<id>"
    finding_id: Mapped[str] = mapped_column(String(80), default="")
    input_key: Mapped[str] = mapped_column(String(64))
    mode: Mapped[str] = mapped_column(String(20))
    content: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
