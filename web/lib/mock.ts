import type { Scorecard, SessionSummary } from "./types";

/** Stand-in data until the API is wired. Shapes match `app/scoring.py` exactly. */

export const SESSIONS: SessionSummary[] = [
  {
    id: "s-2291",
    candidate: "Aditya Rao",
    roleTitle: "Backend engineering intern",
    finishedAt: "today, 11:42",
    durationSeconds: 1086,
    overall: 4.1,
    confidence: "high",
    recommendation: "advance",
    reviewed: false,
  },
  {
    id: "s-2290",
    candidate: "Sneha Iyer",
    roleTitle: "Backend engineering intern",
    finishedAt: "today, 10:15",
    durationSeconds: 742,
    overall: 2.6,
    confidence: "medium",
    recommendation: "another_round",
    reviewed: false,
  },
  {
    id: "s-2289",
    candidate: "Rahul Menon",
    roleTitle: "Backend engineering intern",
    finishedAt: "yesterday, 17:03",
    durationSeconds: 903,
    overall: 2.2,
    confidence: "medium",
    recommendation: "another_round",
    reviewed: true,
  },
  {
    id: "s-2288",
    candidate: "Meera Nair",
    roleTitle: "Backend engineering intern",
    finishedAt: "yesterday, 15:20",
    durationSeconds: 231,
    overall: null,
    confidence: "low",
    recommendation: "inconclusive",
    reviewed: false,
  },
];

export const SCORECARD: Scorecard = {
  sessionId: "s-2291",
  candidate: "Aditya Rao",
  roleTitle: "Backend engineering intern",
  overall: 4.1,
  confidence: "high",
  recommendation: "advance",
  stopReason: "sufficient_evidence",
  escalationNote: null,
  durationSeconds: 1086,
  turns: 19,
  costUsd: 1.42,
  skills: [
    {
      key: "backend_depth",
      name: "Backend fundamentals",
      score: 4.5,
      covered: true,
      evidence: [
        {
          score: 4.5,
          at: 214,
          quote:
            "I kept the embedding in the chunks table instead of a separate store because I only had 12000 rows and a join per query was cheaper than running a second service.",
          note: "Sized the decision against his actual data, not a general rule.",
        },
      ],
    },
    {
      key: "api_design",
      name: "API and data modelling",
      score: 4,
      covered: true,
      evidence: [
        {
          score: 4,
          at: 388,
          quote:
            "POST /documents took a file and returned a job id because ingestion took about 40 seconds and I did not want to hold the connection.",
          note: "Async boundary chosen for a measured reason.",
        },
      ],
    },
    {
      key: "ai_agents",
      name: "LLM and agent concepts",
      score: 4.5,
      covered: true,
      evidence: [
        {
          score: 4.5,
          at: 602,
          quote:
            "Mine was a chain, honestly. I called it an agent in the README at first and that was wrong.",
          note: "Corrected his own overclaim without prompting.",
        },
      ],
    },
    {
      key: "ownership",
      name: "Ownership and debugging",
      score: 4,
      covered: true,
      evidence: [
        {
          score: 4,
          at: 771,
          quote:
            "I assumed the embedding model was the problem and wasted an evening on it. Then I printed the chunk lengths and they were all zero.",
          note: "Named the wrong hypothesis before the right one.",
        },
      ],
    },
    {
      key: "communication",
      name: "Technical communication",
      score: null,
      covered: false,
      evidence: [],
    },
  ],
  claims: [
    {
      id: "c1",
      text: "Built a document Q&A service used by 200 students during placement season.",
      status: "verified",
      note: "Named the test set and the recall numbers before and after.",
    },
    {
      id: "c2",
      text: "Designed the ingestion API and the Postgres schema behind it.",
      status: "verified",
      note: "Explained the schema split and why he avoided a second store.",
    },
    {
      id: "c3",
      text: "Deployed on a single VM with nginx and systemd, no orchestration.",
      status: "unverified",
      note: "Ran out of time before this was probed.",
    },
  ],
  transcript: [
    {
      at: 0,
      speaker: "agent",
      text: "I'm the first-round screen for the backend intern role. To start, tell me about the document Q&A service on your resume.",
      tools: [],
    },
    {
      at: 34,
      speaker: "candidate",
      text: "I built it during placement season. Students uploaded past papers and asked questions against them.",
      tools: [],
    },
    {
      at: 96,
      speaker: "agent",
      text: "What chunking strategy did you pick, and what broke when you first tried it?",
      tools: ["retrieve_rubric", "plan_probe"],
    },
    {
      at: 118,
      speaker: "candidate",
      text: "I started with fixed 500-character chunks and recall was bad for anything spanning a heading. I switched to splitting on headings first, then packing paragraphs up to 500 characters, and top-3 recall went from roughly half to about 85 percent on the 40 questions I had written down as a test set.",
      tools: [],
    },
    {
      at: 214,
      speaker: "agent",
      text: "That's a real measurement. Where did you keep the embeddings, and why there?",
      tools: ["record_evidence", "mark_claim"],
    },
    {
      at: 388,
      speaker: "candidate",
      text: "Postgres, one table for documents and one for chunks, pgvector for the embeddings in the chunks table.",
      tools: [],
    },
    {
      at: 602,
      speaker: "agent",
      text: "You called it an agent in your README. What's the difference between what you built and an agent?",
      tools: ["get_resume_section", "record_evidence"],
    },
    {
      at: 771,
      speaker: "candidate",
      text: "A chain runs the steps I wrote in the order I wrote them. Mine was a chain, honestly.",
      tools: [],
    },
    {
      at: 1040,
      speaker: "agent",
      text: "That's everything I needed. Someone from the team will follow up on next steps. Thanks for walking me through it.",
      tools: ["record_evidence", "end_interview"],
    },
  ],
  integrity: [
    { kind: "tab_hidden", detail: "Switched away for 14s", at: 560 },
    { kind: "second_voice", detail: "A second speaker was detected once", at: 742 },
  ],
};
