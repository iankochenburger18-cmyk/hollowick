# Build Plan — AI Video Aggregator

## Step-by-step: what to actually do, in order

**Phase 0 — Business basics** (parallel to everything else, ~1 day of paperwork)
- [ ] Pick the name (or leave it open — nothing below depends on it except the domain).
- [ ] Register a business entity — Stripe and most payment tooling won't take a personal account seriously otherwise.
- [ ] Buy the domain.

**Phase 1 — Accounts and environment** (~1 day)
- [ ] Spin up the Hetzner server: CPX22 instance, SSH key, Docker + Docker Compose installed.
- [ ] Point the domain's DNS at the server, put Cloudflare in front (free tier).
- [ ] Sort your Stripe setup (new account vs. same entity — see the Stripe discussion), grab test-mode API keys.
- [ ] Sign up for API access with 2–3 providers to start — Sora and Luma have the cleanest self-serve usage-based APIs. Grab the keys.
- [ ] Create a GitHub repo, install Claude Code.

**Phase 2 — Brief Claude Code**
- [ ] Drop this file into the repo root as ARCHITECTURE.md (or paste it as the first message in a new session) — it already carries the stack, hosting, provider pricing, backend functions, pricing model, and positioning.
- [ ] First session: scaffold the project — Docker Compose stack (app, worker, Postgres, Redis, Caddy), empty users/jobs/credits schema, basic auth. No generation logic yet.

**Phase 3 — Build in this order**
- [ ] Single-provider MVP: prompt → job queued → provider called → video lands in storage → user sees it. One provider, no billing — just prove the pipeline end to end.
- [ ] Add the 2nd and 3rd providers via the adapter pattern.
- [ ] Wire up Stripe: subscriptions, credit tracking, the tiers from "Pricing strategy."
- [ ] Build in the trust/differentiation pieces deliberately: rollover credits, refund-on-failure, real cost shown before generating.

**Phase 4 — Ship it**
- [ ] Deploy for real on the Hetzner box, TLS via Caddy.
- [ ] Run the full paid flow yourself in Stripe test mode before going live.
- [ ] Soft-launch to a handful of real people before any public push.

## Short answer on Hetzner

Yes, Hetzner works fine — for everything except the one thing you might assume you need it for. You don't need GPU servers, because you're not running the video models yourself; Runway, Kling, Veo, etc. run on their own infrastructure, and your server just makes API calls to them and manages the result. So your Hetzner box's job is: serve the web app, run the database, run a job queue, store finished videos (or hand them off to object storage), and handle billing webhooks. That's a completely normal CPU workload — Hetzner's cloud VPS line (CX/CPX/CCX) is well suited to it and meaningfully cheaper than AWS/GCP/Azure for the same specs. The one gap is that Hetzner has no managed Postgres or Redis — you either self-host those on the same box (fine at your stage) or point to a managed provider like Supabase (Postgres) or Upstash (Redis) if you'd rather not run databases yourself. Worth knowing going in: Hetzner raised cloud prices in 2026, so double-check current numbers on their site before committing — the figures below are what's live as of this plan.

## Architecture, layer by layer

- **Frontend** — a Next.js (or similar) web app. Handles auth, the generation UI, credit balance display, and history of past generations.
- **Backend API** — a Node or Python service behind the frontend. Owns the "unified generate" endpoint that takes a request and routes it to the right provider adapter.
- **Provider adapters** — one small module per AI video provider (Runway, Luma, Kling, etc.), each translating your internal request format into that provider's specific API call and translating its response back. This is the piece that makes adding a 6th provider later a day of work instead of a rewrite.
- **Job queue + worker** — Redis plus a queue library (BullMQ for Node, Celery/RQ for Python). Generation requests are slow (seconds to minutes), so the API enqueues a job and returns immediately; a worker process picks it up, calls the provider, polls or waits on its webhook, and updates job status. The frontend polls or subscribes for status.
- **Database** — Postgres. Users, credit balances, generation jobs and their status/cost/provider, subscription/plan state.
- **Object storage** — once a provider returns a finished video, download it and store your own copy (provider URLs often expire). Hetzner Object Storage is S3-compatible and roughly €6/TB/month with 1TB storage and 1TB egress bundled into the base price — cheap enough to just use directly, or Cloudflare R2 if you want zero egress fees as you scale.
- **CDN in front** — Hetzner doesn't provide one natively, so put Cloudflare (free tier is enough at first) in front of both the app and the object storage bucket for caching, DDoS protection, and faster delivery outside Europe (all of Hetzner's locations are in Germany/Finland).
- **Auth** — Auth.js/Clerk/Supabase Auth — don't hand-roll this.
- **Billing** — Stripe, for both subscriptions and metered credit top-ups. This is where you enforce the margin: track actual provider cost per generation against what the user's plan/credits charge them.
- **Reverse proxy/TLS** — Caddy (simplest, automatic HTTPS) or nginx in front of the app container.

## Server setup to actually start with

Run everything as Docker containers via Docker Compose on one box at first — app, worker, Postgres, Redis, Caddy. Don't over-architect this before you have users.

**Note on pricing:** Hetzner raised cloud prices twice in 2026 (April and June), by a lot on the dedicated-vCPU line specifically — CCX13 roughly tripled, from €15.99 to €42.99/month. The numbers below are current as of this plan, but confirm against Hetzner's live calculator before you commit, since it's moved twice already this year.

| Plan | vCPU | RAM | Type | €/month |
|---|---|---|---|---|
| CPX22 | 2 | 4GB | shared | 19.49 |
| CPX32 | 4 | 8GB | shared | 35.49 |
| CCX13 | 2 | 8GB | dedicated | 42.99 |
| CCX23 | 4 | 16GB | dedicated | 85.99 |
| CCX33 | 8 | 32GB | dedicated | 138.49 |

- **MVP**: **CPX22** (2 shared vCPU / 4GB, ~€19.49/month). Be honest with yourself about the actual workload here: the backend spends nearly all its time waiting on provider API calls, not computing — that's I/O-bound, not CPU-bound, so a single small core handles a surprising number of concurrent "waiting on Runway/Kling" jobs fine. The one exception that would change this: if you ever process video yourself (thumbnails, watermarking, trimming, re-encoding via ffmpeg) rather than just passing the provider's file straight through to storage, that's real CPU work and would justify sizing up sooner.
- **First thing to actually run low on**: RAM, not CPU — each concurrent job holds a small memory footprint, and Postgres/Redis want their own headroom. Move to **CPX32** (4 vCPU/8GB, ~€35/month) when that's visibly tight, not on a schedule.
- **When it outgrows that**: move to **CCX33** (8 vCPU/32GB, ~€138/month, dedicated) once queue latency or DB contention is visibly the bottleneck, and consider splitting app and worker onto separate boxes at that point.
- Add Hetzner Object Storage as a separate line item once you're storing real generated videos, not before (~€6/TB/month, roughly unchanged by the 2026 increases).

## Non-infrastructure prerequisites

These will block you faster than any server decision, so sort them in parallel with early coding, not after:

- **Provider access**: confirm which providers you're integrating actually offer self-serve API access today (Runway and Luma have public APIs; others vary and change often), and check each one's terms of service on reselling/white-labeling generations — this is the part that can quietly become a legal or business-relationship problem later if skipped.
- **Business entity + Stripe**: Stripe (and most ad-spend/payment tooling) wants a registered business behind the account, not a personal one, if you intend to charge real customers.
- **API budget**: open accounts with 2-3 target providers now, even before the app is fully built, so you have real cost data to set your credit pricing against instead of guessing.

## Rough build order

1. **Foundations** — repo scaffold, Docker Compose stack on the Hetzner box, auth, empty Postgres schema (users, jobs, credits).
2. **Single-provider MVP** — one provider (pick whichever has the simplest API) wired end-to-end: submit prompt → job queued → worker calls provider → video lands in object storage → user sees it. No billing yet, just prove the pipeline.
3. **Add providers 2 and 3** — this is where the adapter pattern either pays off or reveals it needs rework. Add a naive "auto-pick" default (even a simple rule-of-thumb, not real ML) so users aren't forced to know the providers by name.
4. **Billing** — Stripe subscriptions/credits, cost tracking per generation per provider, enforce quotas.
5. **Polish + scale prep** — usage dashboards, error handling for provider outages/failures, move worker to its own box if needed.

## Provider API pricing — usage-based vs subscription

Good news: for actual API/developer access (as opposed to the consumer website), nearly every major provider bills usage-based, not subscription — which matches what you want, since it's the only model that lets you actually track cost-per-generation and set your own margin.

| Provider | Access path | Billing | Confirmed rate |
|---|---|---|---|
| OpenAI Sora 2 | Official API | Usage-based, per second, no subscription | $0.10/sec (sora-2, 720p) up to $0.70/sec (sora-2-pro, 1080p); ~50% cheaper via batch processing |
| Luma Ray | Official API | Usage-based, per 5-second block, no subscription | $0.15–$1.20 per 5s depending on resolution (540p–1080p); V2V costs more |
| Google Veo | Vertex AI (enterprise) | Usage-based, per second | ~$0.05–$0.75/sec depending on model tier (Lite vs Fast vs full quality) |
| Google Veo | Gemini API / AI Studio (consumer) | **Subscription**, not usage-based | AI Pro $19.99/mo, AI Ultra $249.99/mo, limited daily generations |
| Kling | Official developer API | Usage-based (per generation/second) — exact official rate not independently confirmed this session | Third-party resellers charge roughly $0.18–$1.70 per 5s clip, stated as "below official rates" — check Kuaishou's own developer docs for the real number |
| Runway | Consumer app | Subscription with monthly credit pools (Free/Standard/Pro/Max/Enterprise) | — |
| Runway | Developer API (dev.runwayml.com) | Exists separately from the consumer app; exact current rate not confirmed this session | Check dev.runwayml.com directly before committing to it as a source |

The pattern worth internalizing: **the consumer app and the developer API are different products with different billing**, even from the same company (Veo and Runway both show this split). When you're evaluating a provider for this business, go straight to their developer/API docs, not their consumer pricing page — the consumer subscription page is the wrong place to look and will make usage-based access look unavailable when it usually isn't.

## How Higgsfield / Artlist actually handle model selection

It's mostly **the user picks**, not a fully automatic system — worth knowing since it simplifies your own build. Both platforms show the user a model picker (Kling, Veo, Sora, Seedance, etc.) before or alongside the prompt box, and the user actively chooses which engine to generate with, because different models genuinely have different strengths people learn to pick for (Kling for motion/character consistency, Veo for photorealism, Sora for physics-heavy scenes) — an opaque auto-pick would hide information users actually want.

Where the "automatic" part comes in is narrower than it sounds: Higgsfield lets you pick a model *family* and then auto-selects the latest version within it (so you don't have to track "Kling 2.1 vs 3.0" yourself, but you do still choose "Kling" over "Veo"), and its CEO has described a separate auto-prompting/auto-selection layer used for specific templated use cases (social-media ad templates, for instance) where the tool is opinionated about the right model for that one job. Artlist is even more straightforwardly manual: pick your model and settings first, then write your prompt.

Practical implication for your own build: don't over-invest in a fancy auto-routing ML system for launch. Ship a clean model picker with short, honest descriptions of what each model is good at (this alone is most of the value users want), and treat "auto-pick a good default for this use case" as a nice-to-have layered on top later, not a launch requirement.

## Competitor model rosters (snapshot, August 2026)

Useful as a reference when deciding which providers to integrate first — pulled directly from Higgsfield's and Artlist's own sites. These lists change fast in this space, so treat this as a snapshot, not a spec.

**Higgsfield** — video: Seedance 2.0, Kling 3.0, Kling o1, Kling 2.6, Wan 2.7, Sora 2 (OpenAI), Veo 3.1 (Google), Grok Imagine (xAI), Gemini Omni Flash (Google). Image: Nano Banana Pro, Flux 2, Seedream 5, GPT Image 2 (OpenAI).

**Artlist** — much broader, bundles video/image/voice/music/avatar under one subscription (~38 generative models total per one review):
- Video: Kling 3.0 / 3.0 Turbo / 3.0 Motion Control / O3 / 2.6 Pro / 2.5 Turbo Pro / 2.1 Pro / 2.1 Standard / 1.6 Pro / 1.6 Standard (Kuaishou); Seedance 2.0 / 2.0 Fast / 1.5 Pro / 1.0 Pro Fast (ByteDance); Veo 3.1 / 3.1 Lite / 3.1 Fast (Google); Sora 2 / Sora 2 Pro (OpenAI); Hailuo 2.3 in four variants (MiniMax); Wan 2.7 / 2.7 Pro; Grok Imagine Video 1.5 / 1.0 (xAI); Happy Horse 1.0 / 1.1 (Alibaba); LTX 2.0 Pro (Lightricks).
- Image: GPT Image 2 / 1.5 / 1 Mini (OpenAI); Nano Banana / 2 / Pro (Google); Seedream 5.0 / 4.5 (ByteDance); Flux.2 (5 variants); Kling 3.0 Image; Ideogram V3; Krea 2; Hunyuan V3; ImagineArt 1.5 Pro; Z-Image Turbo; Artlist Original 1.0 (their one in-house model).
- Voice/music/avatar: ElevenLabs (voice + dubbing), Cartesia, MiniMax voice, Google Lyria 3 / 3 Pro (music), HeyGen / OmniHuman / Veed Fabric / Creatify Aurora (avatar).

## Where to differentiate — what people actually complain about

Pulled from Trustpilot, G2, and forum threads on Higgsfield and Artlist (August 2026 snapshot).

**Higgsfield's recurring complaints:** "unlimited" plans that turn out rate-limited by a hidden system, surprise price hikes on existing plans, monthly credits that expire with no rollover, near-total customer support silence, and arbitrary account suspensions of heavy users with no explanation. One Blind post specifically calls it "bait and switch" over the unlimited-plan claim.

**Artlist's recurring complaints:** a checkout flow people say silently converts monthly to annual billing, confusing/opaque credit pricing, credits that don't roll over, an entry tier that excludes AI entirely (so you can't cheaply test quality before committing to the expensive tier), inconsistent output quality once dumped into ~38 unlabeled models with no guidance, and confusing licensing tied to download vs. publish timing. Their support is praised, for what it's worth.

**Concrete differentiation, cheapest-to-build first:**
- Say exactly what you mean in pricing — never "unlimited" if there's a cap, ever. Single most-repeated complaint across both.
- Let credits roll over, or skip the credit-expiry model entirely with real pay-as-you-go top-ups — your usage-based provider costs make this easier for you than it was for them.
- Make the monthly/annual choice at checkout unambiguous; make cancellation easy to find.
- Actually answer support tickets — a real inbox with an SLA beats Higgsfield's apparent near-silence outright.
- Be transparent about moderation: explain flags, offer appeals, don't silently ban.
- Curate instead of dumping every model on users — a short, honest "what this model is good at" note per option beats Artlist's unlabeled 38-model wall.
- Offer a genuine way to try before subscribing (a cheap/free single generation) rather than forcing a top-tier subscription just to evaluate quality.

## Backend functions to build

Grouped by job, explained in plain language.

**Accounts and money**
- Sign up / log in — creates an account and proves it's really you each time you come back.
- Credit balance tracker — the running number of how many generations a user has left; down when they generate, up when they pay.
- Stripe webhook handler — listens for events Stripe sends (payment succeeded, subscription renewed, card declined) and updates plan/credits automatically.
- Plan/tier check — before letting someone do something, checks whether their current plan actually allows it.

**The generation pipeline (the core of the product)**
- Generate request handler — the front door: takes prompt + chosen model, checks credits, starts a job.
- Job queue — a waiting line for requests, since videos take seconds to minutes; keeps the app from freezing while waiting.
- Provider adapter (one per provider — Runway, Kling, Sora, Veo, etc.) — translates your app's generic request into that provider's specific format and back. Makes adding a new provider later cheap instead of a rewrite.
- Status checker — handles both styles providers use: webhook ("I'm done") and polling ("are you done yet?").
- Result fetcher — grabs the finished video immediately once a provider says it's ready, since provider links often expire.
- Storage uploader — puts the downloaded video into your own storage so it's yours to serve.
- Job status endpoint — what the frontend polls to show "still working…" then "done!"

**Trust and cost control (where the differentiation actually gets implemented)**
- Cost logger — records what each generation actually cost from the provider, so you see real margin per job, not a guess.
- Refund-on-failure — automatically returns the user's credit if a provider call errors out or times out.
- Rate limiter — stops one user (or a bug, or abuse) from running up your bill with far more requests than reasonable.
- Content check — a basic pass over prompts/outputs, paired with a clear explanation when something's blocked rather than a silent ban.

**Everyday user features**
- History/library — lets a user see and re-download past generations.
- Model catalog — the list of currently-enabled models, what they cost you, and an honest note on what each is good at; powers the model picker in the UI.
- Notifications — tells the user their video is ready (in-app/email/push) instead of making them watch a spinner.

**Behind the scenes**
- Admin tools — simple internal pages to look up a user's account, see what went wrong, or refund credits by hand, without touching the database directly.
- Retry logic — automatically retries a failed provider call a couple of times (network blips happen) before giving up and refunding.

## Pricing strategy

**Real cost per generation, by quality tier** (5-second clip, from confirmed provider rates): cheap/fast models (Seedance Fast, Luma 540p) ~$0.15–$0.50; mid-tier (Kling standard, Veo Fast) ~$0.50–$1.00; premium (Sora 2 Pro 1080p, full-quality Veo) ~$2.50–$4.00. Nearly a 20x spread between cheapest and priciest model — meaning "1 credit = 1 video" flattens away real cost differences the moment you offer more than one model.

**Benchmark — Higgsfield's real math:** Starter plan $19/mo for 270 credits (~15 videos, cheapest models only) ≈ $1.27/video at full usage. By their own admission, unused credits don't roll over, so under-users pay more per video in practice (~$1.90/video at 10 videos/month) — this "breakage" is quietly part of their margin, and it's also exactly what drives the complaints logged earlier.

**Pricing principles for this build:**
- Show real cost before generating ("this will use 8 credits" vs "60 credits") instead of a flat number that hides a 20x cost spread.
- Target ~2.5–4x markup over actual provider cost (covers Stripe's ~3%, infra/support overhead, and real margin). Example: a $0.50 mid-tier generation → charge roughly $1.25–$2.00.
- Let credits roll over at least one cycle (or decay slowly, never hard-expire monthly) — don't build margin on breakage the way competitors do.
- Offer pay-as-you-go top-ups at a fixed, disclosed rate at every tier, not just the top one — avoids the "forced tier jump just to keep testing AI" complaint.

**Starting tier structure (first pass, refine once you have real usage data):**
- Starter ~$15–19/mo — fast/cheap models only, credits roll over once.
- Pro ~$39–49/mo — adds mid-tier model access.
- Studio ~$89–99/mo — unlocks premium models (Sora Pro, etc).
- Pay-as-you-go top-ups available at every tier, same disclosed per-credit rate.

## Handing this to Claude Code

Since you're building this in Claude Code directly, this file works well dropped into the repo root as `ARCHITECTURE.md` (or pasted as the first message in a new session) — it gives Claude Code the constraints (Hetzner target, Docker Compose, provider-adapter pattern, phase order) so it isn't guessing at your infra or re-deriving the plan from scratch each session.
