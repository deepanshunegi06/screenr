"""Provider-agnostic chat model factory.

The agent's behaviour must not depend on which vendor is answering. Swapping
providers is an env var, not a refactor -- see docs/adr/002-llm-adapter.md.
"""

from langchain_core.language_models.chat_models import BaseChatModel

from .config import get_settings


def build_llm(temperature: float = 0.3) -> BaseChatModel:
    s = get_settings()
    provider = s.llm_provider.lower()

    if provider == "groq":
        from langchain_groq import ChatGroq

        return ChatGroq(
            model=s.llm_model,
            temperature=temperature,
            api_key=s.groq_api_key,
            timeout=30,
            # The free tier is 8k tokens/minute and an interview will hit it.
            # The SDK honours the Retry-After header, so waiting is cheaper than
            # failing a turn mid-conversation.
            max_retries=5,
        )

    if provider == "gemini":
        from langchain_google_genai import ChatGoogleGenerativeAI

        return ChatGoogleGenerativeAI(
            model=s.llm_model,
            temperature=temperature,
            google_api_key=s.google_api_key,
        )

    if provider == "anthropic":
        from langchain_anthropic import ChatAnthropic

        return ChatAnthropic(
            model=s.llm_model,
            temperature=temperature,
            api_key=s.anthropic_api_key,
            timeout=20,
        )

    raise ValueError(f"unknown llm_provider: {s.llm_provider}")
