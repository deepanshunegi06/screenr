"""Run an interview in the terminal, in text, with no audio.

    python -m app.cli                              interview yourself
    python -m app.cli --persona bluffer            watch a scripted candidate
    python -m app.cli --persona all                run every persona, print the traces
    python -m app.cli --json evals/results/latest.json
                                                   run every persona, write the report the
                                                   evals page renders
    python -m app.cli --persona silent --voice     same, but through the real Deepgram
                                                   agent -- costs agent-hours

This is how development happens. Audio costs credit and takes twenty minutes a
run; text costs almost nothing and takes seconds, so the agent's behaviour gets
exercised hundreds of times before a microphone is ever involved.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

from .agent.graph import Interviewer
from .config import get_settings
from .roles import build_context
from .scoring import build_scorecard


def _print_card(card: dict) -> None:
    overall = f"{card['overall']:.2f}" if card["overall"] is not None else "—"
    print("\n" + "-" * 60)
    print(f"  {card['role_title']}   {card['duration_seconds']}s   {card['turns']} turns")
    print(f"  overall {overall}  |  {card['confidence']} confidence")
    print(f"  recommendation: {card['recommendation']}  (a human decides)")
    if card["escalation_note"]:
        print(f"  flagged for review: {card['escalation_note']}")
    if card["stop_reason"]:
        print(f"  ended: {card['stop_reason']}")
    print("-" * 60)
    for skill in card["skills"]:
        score = skill["score"]
        shown = f"{score:.1f}" if score is not None else "  -"
        print(f"  {shown}  {skill['name']}")
        for item in skill["evidence"]:
            quote = item["quote"]
            print(f'        "{quote[:88]}{"..." if len(quote) > 88 else ""}"')
    if any(c["status"] != "unverified" for c in card["claims"]):
        print("\n  resume claims")
        for claim in card["claims"]:
            print(f"    [{claim['status']:>10}] {claim['text'][:70]}")
    print()


def run_personas(names: list[str], json_path: str | None, voice: bool = False) -> int:
    import asyncio

    from evals import personas as p
    from evals.runner import build_report, run_interview

    lookup = {persona.name: persona for persona in p.ALL}
    chosen = p.ALL if names == ["all"] else [lookup[n] for n in names]

    runs = []
    errored: list[str] = []

    if voice:
        # The real socket, the real model, answered in text. All personas at
        # once: the sweep takes as long as its slowest interview, not the sum.
        from evals.voice_runner import clear_stray_sessions, run_all

        if stray := clear_stray_sessions():
            print(f"cleared {stray} eval session(s) left by an interrupted run")
        results = asyncio.run(run_all(chosen, max_turns=16))
        for persona, result in zip(chosen, results, strict=True):
            if isinstance(result, BaseException):
                print(f"=== {persona.name} === ERROR {type(result).__name__}: {str(result)[:200]}")
                errored.append(persona.name)
                continue
            runs.append(result)
    else:
        for persona in chosen:
            try:
                runs.append(run_interview(persona, max_turns=14))
            except Exception as exc:  # one provider outage must not lose the rest
                print(f"=== {persona.name} === ERROR {type(exc).__name__}: {str(exc)[:200]}")
                errored.append(persona.name)

    for run in runs:
        print(run.pretty())
        _print_card(run.scorecard)

    failed = [r.persona.name for r in runs if not r.passed]
    print(
        f"\n{len(runs) - len(failed)}/{len(runs)} personas passed" + (f"; failed: {failed}" if failed else "")
    )

    if json_path and not runs:
        # Every persona errored -- a rate limit, or the provider being down.
        # Replacing real results with an empty file because nobody could be
        # reached would destroy the only evidence there is.
        print(f"\nnothing ran, so {json_path} is unchanged")
    elif json_path:
        s = get_settings()
        report = build_report(
            runs,
            model=s.voice_think_model if voice else s.llm_model,
            provider=f"deepgram / {s.voice_think_provider}" if voice else s.llm_provider,
            ran_at=datetime.now(UTC).isoformat(),
        )
        report["errors"] = [{"persona": name, "reason": "did not run"} for name in errored]
        out = Path(json_path)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")
        print(f"report written to {out}")
    return 1 if (failed or errored) else 0


def run_live(rubric: str, resume_path: str | None) -> int:
    resume = Path(resume_path).read_text(encoding="utf-8") if resume_path else ""
    ctx = build_context(rubric, resume_text=resume)
    agent = Interviewer(ctx)

    print("\n(type 'quit' to stop)\n")
    print(f"  agent: {agent.open()}\n")

    while not ctx.is_finished():
        try:
            answer = input("  you: ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if answer.lower() in {"quit", "exit"}:
            break
        if not answer:
            continue
        print(f"\n  agent: {agent.turn(answer)}\n")

    _print_card(build_scorecard(ctx))
    print("  tools called per turn:")
    for i, turn in enumerate(ctx.tool_log):
        print(f"    {i}: {' -> '.join(turn) or '(spoke without calling tools)'}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="screenr")
    parser.add_argument("--persona", help="scripted candidate name, or 'all'")
    parser.add_argument("--json", help="write an eval report here (implies --persona all)")
    parser.add_argument("--rubric", default="backend_intern")
    parser.add_argument("--resume", help="path to a resume text file")
    parser.add_argument(
        "--voice",
        action="store_true",
        help="run the personas through the real Deepgram agent instead of the typed path",
    )
    args = parser.parse_args()

    if args.json or args.persona:
        names = [n.strip() for n in (args.persona or "all").split(",")]
        return run_personas(names, args.json, voice=args.voice)
    return run_live(args.rubric, args.resume)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    sys.exit(main())
