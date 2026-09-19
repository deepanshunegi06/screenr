from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # LLM provider is swappable so the agent is not tied to one vendor.
    llm_provider: str = "groq"
    llm_model: str = "openai/gpt-oss-120b"
    groq_api_key: str = ""
    openai_api_key: str = ""
    google_api_key: str = ""
    anthropic_api_key: str = ""

    # SQLite lives here. Postgres would be the move for a multi-instance deploy;
    # for one box, a file is the whole persistence story.
    data_dir: str = "data"

    deepgram_api_key: str = ""
    # The model Deepgram runs for voice interviews. Separate from llm_model:
    # that one names a model on OUR provider, this one names a model on theirs.
    voice_think_model: str = "claude-sonnet-5"
    voice_think_provider: str = "anthropic"
    # Needed to read per-session usage back out of Deepgram.
    deepgram_project_id: str = ""

    # Sending invites. Resend will only deliver to the account owner until a
    # domain is verified, so a send can legitimately fail on a working key.
    # Brevo is the one that can do both: an HTTPS API a host cannot firewall off,
    # and a single sender address verified by a code rather than by DNS.
    brevo_api_key: str = ""
    resend_api_key: str = ""
    mail_from: str = "screenr <onboarding@resend.dev>"
    # Plain SMTP, used when smtp_user is set. Gmail with an app password needs no
    # domain of its own, which is the whole reason it is here.
    smtp_host: str = "smtp.gmail.com"
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    # Where an invite link points. The API cannot know the web origin otherwise.
    web_origin: str = "http://localhost:3000"

    # Single hardcoded recruiter for v1. See docs/adr/004-no-auth-provider.md.
    recruiter_email: str = "recruiter@screenr.local"
    recruiter_password: str = "changeme"
    jwt_secret: str = "dev-secret-change-me"
    # Exposes POST /auth/demo, which mints a recruiter token without a password.
    # For demos only; the password itself is never sent anywhere.
    demo_mode: bool = False

    # Guardrails. Enforced server-side, never trusted from the client.
    max_interview_seconds: int = 1200
    max_turns: int = 60
    max_probes_per_topic: int = 2
    max_tool_iterations: int = 6
    # Integrity warnings before the interview is ended. Ending is not judging:
    # the scorecard records why, and a human still decides.
    max_integrity_warnings: int = 3

    cors_origins: str = "http://localhost:3000"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
