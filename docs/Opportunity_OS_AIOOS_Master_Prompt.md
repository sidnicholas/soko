# AIOOS — Proactive Opportunity Discovery & Transaction Matching Engine (Master Build Prompt)

**Source:** `soko-extended-prd.docx` (user-supplied, added 2026-10-03), converted to Markdown. Text preserved; only headings and list markers added.
**Reads with:** `Opportunity_OS_AIOOS_Gap_Analysis.md` (the §31 inspection report + vertical-slice plan), `Opportunity_OS_PROJECT_MEMORY.md` (build state).

Continue development of the existing application. Do not rebuild the application from scratch. First inspect the existing codebase, architecture, database, search functionality, AI integrations, interfaces, agents, workflows, and completed features. Preserve working components and extend the current architecture.

## Mission

Transform the existing application into a proactive AI Opportunity Operating System (AIOOS) capable of continuously discovering, verifying, matching, scoring, and presenting real-world economic opportunities across the internet.
The system should not merely wait for a user to enter what they need.
It should proactively search for:
Demand → then find supply
and independently:
Supply → then find demand
The central question is:
Where does unmet or poorly matched demand exist, where does corresponding supply exist, can the two sides realistically transact, and is there a legitimate way for the user to create enough value in facilitating or solving the transaction to be compensated?
Optimize for:
verified, actionable, monetizable opportunities per unit of time and search cost — not number of pages crawled, listings collected, or theoretical matches generated.

## 1. Immediate Rapid Opportunity Mode

Add a special operating mode called something like:
Rapid Opportunity Mode
This mode should prioritize opportunities capable of producing revenue extremely quickly.
For the current experiment, assume:
- starting capital is approximately zero;
- the user has a computer and internet connection;
- the user can provide professional services and perform research/coordination;
- there is no large existing audience or sales funnel;
- there is no assumption of warm relationships;
- outreach should primarily be electronic;
- owner-operated businesses, entrepreneurs, individuals and accessible decision-makers are especially valuable;
- opportunities reachable evenings and weekends receive additional weight;
- speed-to-cash matters more than building a long-term business during this mode.
Use $6,000 as an experimental revenue target, not as an assumption or promise.
Do not manipulate scoring merely to make opportunities appear capable of reaching $6,000.
Instead determine objectively whether opportunities exist that could individually or collectively approach that target.

## 2. Internet Intelligence Architecture

Give the AI controlled internet-search capabilities through a provider-agnostic search abstraction.
The reasoning layer should be able to make calls conceptually similar to:
search(query, filters, source_type)
without application logic being permanently tied to one provider.
Evaluate current options such as general web-search APIs, semantic search providers, official marketplace APIs, RSS/Atom feeds, structured-data feeds, email alerts, authorized marketplace integrations, permitted crawling infrastructure, and browser automation where appropriate.
Candidate technologies to evaluate include:
- Brave Search API
- Exa
- Firecrawl
- Apify
- Playwright
- Crawlee
These are candidates, not mandatory dependencies. Evaluate current capabilities, pricing, restrictions and suitability before implementation.
Prefer official APIs, feeds and authorized access methods whenever available.
Do not bypass authentication, CAPTCHAs, access controls, robots restrictions, rate limits, paywalls, or other technical safeguards.
Do not assume that information visible to a human account can legally or technically be collected automatically.
For gated networks such as Facebook Marketplace or Facebook Groups, investigate compliant access mechanisms rather than assuming unrestricted scraping.

## 3. Source Discovery

Do not limit the system to a manually created list of websites.
Build source discovery.
If AIOOS repeatedly encounters a new marketplace, forum, RFQ system, classifieds site, association board, auction system, liquidation marketplace, procurement portal, community, niche directory, or other useful source, evaluate it as a potential new sensor.
Maintain a Source Registry containing:
source name, source type, categories, geography, demand/supply orientation, access mechanism, API availability, authentication requirements, cost, rate limits, freshness, reliability, historical yield, terms/access constraints, and actionable opportunities generated.
Over time, calculate source yield:
useful verified opportunities / search cost
Reduce resources devoted to low-yield sources and expand high-yield ones.

## 4. Cast the Net Broadly

Search across as many legitimate opportunity environments as practical, including:
classifieds, wanted listings, RFQs, procurement notices, business forums, industry forums, Reddit communities, public social discussions, liquidation markets, wholesale marketplaces, machinery marketplaces, equipment markets, auctions, surplus inventory, business-for-sale environments, contractor requests, service requests, local marketplaces, specialty marketplaces, freight/capacity signals, commercial real estate signals, hard-to-find components, distressed inventory, e-commerce problems, website/revenue problems, job/project marketplaces, and newly discovered niche sources.
Examples such as Craigslist should be considered, but do not restrict the system to the marketplaces we already know.
Search for language indicating intent:
wanted
WTB
looking for
need
need immediately
urgent
seeking
RFQ
request for quote
supplier needed
contractor needed
ISO
shortage
backordered
can't find
sold out
liquidating
must sell
warehouse closing
surplus
excess inventory
overstock
project stalled
and semantically equivalent language.
The AI should learn additional phrases rather than depend exclusively on these keywords.

## 5. Demand-First Search

When AIOOS detects credible demand, automatically investigate:
Who needs it?
Exactly what do they need?
How much?
Where?
When?
What specifications matter?
What evidence demonstrates actual purchase intent?
Can the buyer or decision-maker be contacted?
How urgent is the need?
Then independently search for potential supply.
Do not surface a strong match until supply has been investigated.

## 6. Supply-First / Reverse Matching

Run the process in reverse.
When the system discovers unusually attractive supply — including surplus, distressed inventory, unused capacity, liquidation, discounted equipment, underutilized assets or specialized expertise — ask:
Who needs this right now?
Search independently for demand.
This is essential because some of the best opportunities may begin with unusual supply rather than an explicit wanted advertisement.

## 7. Cross-Market and Cross-Network Matching

AIOOS should specifically look for situations where demand and supply live in different information environments.
Example:
A buyer expresses an urgent need on Network A.
A seller has the required inventory on Network B.
Neither knows the other exists.
This information fragmentation is potentially where AIOOS creates value.
Search across categories, industries, marketplaces and — where transaction economics justify it — geographic regions.
Look for:
- price discrepancies;
- availability discrepancies;
- geographic mismatches;
- information asymmetry;
- unused capacity;
- distressed supply;
- unmet urgent demand;
- fragmented markets;
- poor searchability;
- difficult-to-source items;
- timing mismatches;
- expertise mismatches.

## 8. Services Are Supply Too

Do not interpret "supply" only as physical products.
Supply can include:
expertise, labor, analytics, marketing, conversion optimization, website repair, WordPress/Divi work, GA4/GTM implementation, research, sourcing, coordination, project management, automation, logistics expertise and other services.
Look for situations where a business has a financially expensive problem, rather than merely searching for freelance job postings.
Example:
Don't simply search:
"GA4 contractor wanted"
Also search for observable evidence that businesses may be losing leads, wasting advertising spend, experiencing broken checkout/lead funnels, suffering tracking failures, having website failures, or experiencing other measurable commercial problems.

## 9. Opportunity Verification Engine

AIOOS must be a verification engine, not merely a discovery engine.
Every candidate should be tested for:
- source freshness;
- listing age;
- continued availability;
- evidence that the buyer/seller is real;
- entity identity;
- duplicate listings;
- stale reposts;
- conflicting information;
- suspicious behavior;
- independently corroborating information where practical.
Distinguish:
Verified
Strongly supported
Plausible
Speculative
Rejected
Never present speculation as verified opportunity.

## 10. Entity Resolution

Build entity resolution so that:
"ABC Manufacturing LLC," "ABC Mfg," an email address, a marketplace account and a website are recognized as potentially representing the same organization.
Avoid presenting the same underlying opportunity repeatedly because it appeared on several sites.
Preserve evidence connecting resolved entities.

## 11. Freshness and Opportunity Decay

Opportunities lose value over time.
Calculate an Opportunity Freshness/Decay Score based on:
- posting age;
- urgency;
- marketplace turnover;
- evidence of continuing demand;
- seller availability;
- likely competitive pressure;
- known deadlines.
A three-hour-old urgent RFQ should generally receive different treatment from a 90-day-old wanted advertisement.
Recheck promising opportunities before major outreach.

## 12. Economic Feasibility Engine

Never equate transaction value with user revenue.
For every opportunity estimate, when possible:
- gross transaction value;
- acquisition cost;
- shipping/freight;
- marketplace fees;
- payment-processing costs;
- taxes/duties where relevant;
- financing requirements;
- insurance;
- escrow;
- labor;
- third-party contractors;
- returns/default risk;
- time requirement;
- expected user compensation;
- expected net value.
Calculate ranges rather than false precision.

## 13. The "Why Do We Get Paid?" Test

This is mandatory.
Every opportunity must answer:
What legitimate value are we adding?
Why would someone compensate us?
Who would pay us?
How would compensation be structured?
When would payment occur?
Possible structures might include, where appropriate and lawful:
- fixed service fee;
- sourcing fee;
- consulting fee;
- referral arrangement;
- commission;
- project fee;
- success fee;
- reseller margin;
- coordination fee;
- retainer;
- deposit plus completion payment.
Do not assume entitlement to commissions or fees merely because two parties were discovered.
If the compensation mechanism is unclear, classify the opportunity as:
Potential match — monetization unresolved.

## 14. Regulatory and Legal Screening

Identify opportunities involving industries or transaction types that may require:
licenses, broker authority, freight-broker authority, real-estate licensing, securities registration, insurance licensing, employment-agency licensing, medical/pharmaceutical compliance, export/import authorization, controlled-goods compliance or other regulatory permissions.
Flag these before outreach or transaction activity.
Do not recommend structuring transactions merely to evade licensing requirements.
Regulatory uncertainty should reduce actionability until verified.

## 15. Fraud and Trust Engine

High transaction value combined with low verification should increase scrutiny rather than opportunity score.
Check for signals including:
- recently created domains;
- inconsistent business identities;
- unusual payment requirements;
- cryptocurrency-only payment demands;
- advance-fee schemes;
- stolen listing photographs;
- implausible pricing;
- unverifiable inventory;
- suspicious contact information;
- inconsistent addresses;
- repeated scam reports;
- pressure tactics.
Recommend escrow, contracts, verification or other safeguards when appropriate.

## 16. Contactability and Decision-Maker Resolution

A theoretically perfect opportunity is useless for Rapid Opportunity Mode if nobody can be reached.
Determine:
Who can actually say yes?
Search for legitimate public business contact paths such as:
- marketplace messaging;
- business email;
- website contact forms;
- publicly listed business telephone numbers;
- professional profiles;
- official social accounts;
- public procurement contacts.
Score:
Decision-maker accessibility
and
Expected response speed.
Respect privacy and platform communication rules.

## 17. Outreach Intelligence

For strong opportunities, generate a concise recommended outreach message grounded in the specific evidence discovered.
Avoid generic spam.
Explain:
what signal we observed,
what problem we believe exists,
what we can potentially solve or connect,
and
the lowest-friction next step.
Where appropriate, generate separate outreach for the demand side and supply side.
Do not make claims that have not been verified.
Human approval should be required before external communication unless explicit authorization for automated communication has been configured.

## 18. Opportunity Scoring

Build a transparent scoring model incorporating:
- evidence strength;
- freshness;
- urgency;
- demand credibility;
- supply credibility;
- match quality;
- transaction value;
- expected user compensation;
- expected net revenue;
- probability of reaching decision-maker;
- likely response speed;
- transaction friction;
- capital required;
- time required;
- competitive pressure;
- legal/regulatory complexity;
- fraud risk;
- execution complexity;
- geographic friction;
- payment speed.
Every score must be explainable.
Never output only:
Score: 91
Explain why it received 91 and what could invalidate that score.

## 19. Expected-Value Ranking

Don't rank opportunities merely by maximum possible payoff.
Consider something conceptually like:
Expected Value = plausible net compensation × estimated probability of successful execution
adjusted for:
time + capital + friction + risk + opportunity decay
Avoid pretending these probabilities are scientifically precise when evidence is weak.
Use ranges and confidence levels.

## 20. Portfolio Thinking

Do not treat the $6,000 experiment as requiring one $6,000 transaction.
Consider combinations such as:
- one large transaction;
- two medium transactions;
- several smaller rapid transactions;
- a service deposit plus sourcing fee;
- other legitimate combinations.
The system should be capable of constructing an Opportunity Portfolio whose combined realistic near-term revenue approaches the target.

## 21. Progressive Search Depth

Do not spend expensive search resources equally on every lead.
Use stages:
Stage 1 — inexpensive broad discovery
Stage 2 — preliminary matching
Stage 3 — verification
Stage 4 — economics
Stage 5 — decision-maker/contact research
Stage 6 — human action recommendation
Kill weak candidates early.
Spend deeper research resources only on candidates whose expected value justifies them.

## 22. Search Budgeting

Track:
- API costs;
- AI/token costs;
- browser execution costs;
- proxy/data costs where legitimately used;
- compute;
- time;
- opportunities discovered;
- verified opportunities;
- contacted opportunities;
- responses;
- transactions;
- revenue.
Ultimately calculate:
cost per actionable opportunity
and eventually:
cost per dollar of realized revenue.

## 23. Autonomous Query Expansion

Do not rely on one search query.
Allow the reasoning engine to create follow-up queries based upon discoveries.
Example:
Demand signal found →
extract product/specification/location/quantity/deadline →
generate multiple supply queries →
inspect results →
identify potential suppliers →
verify inventory →
calculate economics →
find contact path.
Likewise perform the reverse process beginning with supply.
Prevent uncontrolled loops through search budgets, depth limits and diminishing-return detection.

## 24. Learning From Failure

Record why opportunities fail:
- stale;
- already sold;
- no response;
- wrong decision-maker;
- economics failed;
- supply unavailable;
- demand wasn't genuine;
- fee impossible;
- regulatory barrier;
- fraud;
- competitor beat us;
- price mismatch;
- shipping destroyed economics;
- insufficient trust;
- payment too slow.
Feed these outcomes back into ranking.
AIOOS should become better at recognizing opportunities that actually transact, rather than merely resemble opportunities.

## 25. Learn From Success

When an opportunity produces:
a response, meeting, quote, agreement, deposit or completed transaction,
determine which signals predicted success.
Increase appropriate weight on those signals while avoiding overfitting to a tiny sample.

## 26. Human-in-the-Loop Action Queue

The primary output should not be hundreds of listings.
Produce something closer to:
ACT NOW
3 exceptionally strong opportunities.
VERIFY NEXT
10–15 promising opportunities requiring one additional check.
WATCH
potentially valuable opportunities that aren't ready.
REJECTED
automatically discarded candidates, with reason codes retained for learning.
For every Act Now item provide:
- opportunity;
- evidence;
- demand party;
- supply party;
- why they match;
- source links;
- timestamps;
- estimated economics;
- compensation mechanism;
- decision-maker/contact path;
- risks;
- confidence;
- next recommended action;
- suggested outreach.

## 27. Continuous / Overnight Operation

Architect the discovery process so it can run on schedules without requiring the user to sit at the computer.
It should:
search → discover → deduplicate → match → verify → score → monitor → report.
But do not automatically make purchases, sign agreements, commit funds, represent the user as an authorized broker, or send high-impact external communications without appropriate human authorization.

## 28. Alerts

Allow thresholds such as:
Notify immediately if:
- confidence exceeds threshold;
- estimated net user compensation exceeds threshold;
- capital requirement is below threshold;
- credible buyer and supplier are identified;
- decision-maker is reachable;
- freshness is high.
Otherwise include the opportunity in the next briefing.

## 29. Evidence and Provenance

Every factual opportunity claim should retain:
source URL,source name,discovery timestamp,publication/listing timestamp when available,relevant extracted evidence,search query that produced it,and verification status.
Never allow AI-generated assumptions to become indistinguishable from source facts.
Clearly label:
Source fact
System inference
Estimate
Unknown

## 30. Success Metrics

The project's primary metrics should NOT be:
pages scraped,records collected,searches performed,or AI calls made.
Measure:
Verified actionable opportunities
Decision-makers reached
Response rate
Qualified conversations
Transactions initiated
Time to first dollar
Realized revenue
Net realized revenue
Search cost per actionable opportunity
Search cost per realized dollar

## 31. Initial Implementation Strategy

Before coding, inspect the existing system and report:
A. What already exists
B. What can be reused
C. What is missing
D. What should be modified
E. What should NOT be changed
Then propose the smallest functional vertical slice capable of proving:
Internet signal → demand/supply detection → opposite-side discovery → verification → economics → monetization test → contact path → human action
Do not spend weeks building infrastructure before testing whether this loop produces real opportunities.

## 32. First Live Experiment

Once the minimum vertical slice works, run an actual experiment.
Cast the net broadly enough that we are not imposing our assumptions about where opportunity exists.
Specifically search for economic mismatches that humans currently have difficulty discovering manually.
Let evidence determine which categories deserve additional resources.
Start broad, measure signal quality, and then dynamically concentrate search resources into the most promising categories.
The goal is not to prove our original hypothesis correct.
The goal is to discover where monetizable information asymmetry actually exists.

## 33. Final Design Principle

AIOOS is not fundamentally a scraper.
It is not fundamentally a search engine.
It is not fundamentally a marketplace.
It is an opportunity intelligence system.
Its job is to recognize situations in which:
Party A has a problem or demand.
Party B possesses a solution or supply.
They have not efficiently found one another.
The system discovers and verifies that mismatch.
The user has a legitimate way to add value by resolving it.
The economics justify taking action.
Everything built should ultimately serve that loop.
Build for transactions, not traffic. Build for evidence, not speculation. Build for realized economic value, not impressive-looking search results.
One architectural point in that prompt is especially important: don't make Facebook, Craigslist, or any individual marketplace the product. They are sensors. If Craigslist disappears tomorrow, AIOOS should simply lose one sensor; its intelligence remains intact.
And I think the "Why do we get paid?" test may be the most important addition of all. An AI could discover a $100,000 buyer/seller mismatch that looks spectacular while providing absolutely no contractual or practical way for us to earn a dollar from it. AIOOS needs to reject that as a revenue opportunity until it can establish a legitimate value-add and compensation path. That should prevent us from fooling ourselves with impressive transaction values that aren't actually accessible revenue.
