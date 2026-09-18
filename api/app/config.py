from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # LLM provider is swappable so the agent is not tied to one vendor.
    llm_provider: str = "groq"
    llm_model: str = "openai/gpt-oss-120b"
    groq_api_key: str = ""
    google_api_key: str = ""
    anthropic_api_key: str = ""

    database_url: str = "postgresql+psycopg://screenr:screenr@localhost:5432/screenr"

    deepgram_api_key: str = ""
    # The model Deepgram runs for voice interviews. Separate from llm_model:
    # that one names a model on OUR provider, this one names a model on theirs.
    voice_think_model: str = "gemini-3.1-flash-lite"
    # Needed to read per-session usage back out of Deepgram.
    deepgram_project_id: str = ""
    # Where Deepgram calls us back for each turn. Must be publicly reachable.
    public_api_url: str = "http://localhost:8000"

    # Single hardcoded recruiter for v1. See docs/adr/004-no-auth-provider.md.
    recruiter_email: str = "recruiter@screenr.local"
    recruiter_password: str = "changeme"
    jwt_secret: str = "dev-secret-change-me"
    # Fills the sign-in form so a demo does not open on an empty login box.
    # Must be false anywhere real candidates can reach.
    demo_prefill: bool = True

    # Guardrails. Enforced server-side, never trusted from the client.
    max_interview_seconds: int = 1200
    max_turns: int = 60
    max_probes_per_topic: int = 2
    max_tool_iterations: int = 6

    cors_origins: str = "http://localhost:3000"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
