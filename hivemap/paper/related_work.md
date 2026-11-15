# Hivemap: Related Work Review

**Paper question.** How should LLM-driven robot teams share what they know? We compare three options: (i) no communication, (ii) natural-language messages, and (iii) a shared, verified, open-vocabulary object map built with distributed object-based SLAM.

**Bibliography.** `refs.bib` holds 105 entries. Each one was checked in November 2026 against arXiv API metadata (title, full author list, date, comment or journal-ref field) and/or the Crossref DOI record (venue, volume, pages). Where the venue of an arXiv-only paper could not be confirmed, it is cited as an arXiv preprint (`@misc`) and no venue is guessed.

| Area | Verified entries |
|---|---|
| 1. Multi-robot / collaborative SLAM, distributed estimation | 23 |
| 2. Object-level and semantic SLAM | 9 |
| 3. Open-vocabulary perception, 3D maps, scene graphs (incl. multi-robot) | 19 |
| 4. LLMs for robot planning / embodied agents | 13 |
| 5. LLM multi-agent / multi-robot coordination and communication | 19 |
| 6. Task allocation, exploration, communication-constrained coordination | 8 |
| 7. Embodied (multi-agent) benchmarks and simulators | 9 |
| 8. On-device LLMs and structured decoding | 5 |
| **Total** | **105** |

This is above the requested 45-70 entries. Unused entries do no harm in BibTeX, and the core set for a 1-2 column related-work section is the Section (b) table plus about 25 more entries, marked **[core]** below.

---

## (a) Synthesis by area

### 1. Multi-robot / collaborative SLAM and distributed estimation

**What exists.**

*Back-ends.*
- DDF-SAM [cunningham2010ddfsam] did distributed smoothing by exchanging condensed factor graphs.
- Choudhary et al. [choudhary2016icra, choudhary2017ijrr] **[core]** introduced the two-stage distributed Gauss-Seidel / SOR back-end. It first estimates rotations, then full poses. It needs only partial, privacy-preserving exchange of separator estimates and uses communication linear in the number of separators. The IJRR paper also showed that *object-based* landmarks shrink the separator and the bandwidth.
- Tian et al. [tian2021dc2pgo] made distributed PGO certifiably correct (DC2-PGO).

*Full systems.*
- Decentralized: DOOR-SLAM [lajoie2020doorslam], Kimera-Multi [chang2021kimeramulti, tian2022kimeramulti] **[core]**, Swarm-SLAM [lajoie2024swarmslam] **[core]**, D2SLAM [xu2024d2slam], DiSCo-SLAM [huang2022discoslam] and SlideSLAM [liu2025slideslam]. The last two use two-stage global/local optimization and a sparse object-level semantic map, respectively.
- Centralized: CCM-SLAM [schmuck2019ccmslam] and COVINS [schmuck2021covins].
- Field-tested: LAMP / LAMP 2.0 [ebadi2020lamp, chang2022lamp2].

*Communication efficiency.*
- Cieslewski et al. [cieslewski2018icra] **[core]** made place recognition and data exchange bandwidth-efficient.
- Tian et al. [tian2018budgeted] studied budgeted data exchange for distributed loop-closure detection.

*Robustness to bad inter-robot loop closures.*
- PCM [mangelson2018pcm] **[core]** and graduated non-convexity [yang2020gnc] are now standard. DOOR-SLAM, Kimera-Multi and Swarm-SLAM all use one or both.

*Map merging with unknown initial frames.*
- Rendezvous / relative-pose measurements [zhou2006rendezvous], particle-filter multi-robot SLAM with encounters [howard2006ijrr], and multiple relative pose graphs [kim2010multiple].
- Surveys: Lajoie et al. [lajoie2022survey] **[core]** and Cadena et al. [cadena2016past].

**How we differ.** Hivemap does not propose a new SLAM back-end. It reuses the two-stage DGS/SOR scheme of [choudhary2016icra, choudhary2017ijrr]. Map merging is seeded by robot-robot encounters, in the spirit of [zhou2006rendezvous, howard2006ijrr], and verified with appearance+geometry object matching and anti-aliasing checks, in the spirit of PCM/GNC.

Two things are new here:
1. **Who triggers the mapping operations.** Exchange, merge and optimize are *tools invoked by an LLM agent* rather than a fixed pipeline.
2. **How the map is evaluated.** It is judged as a *communication medium for downstream LLM task performance* (fetch, inventory, rendezvous, dispatch, search), not by ATE/RPE alone.

Prior collaborative-SLAM work reports trajectory and map accuracy and bandwidth. None of it asks whether the shared map helps a team of language agents more than talking does.

### 2. Object-level and semantic SLAM

**What exists.**
- SLAM++ [salasmoreno2013slampp] used known object instances as landmarks.
- Choudhary et al. [choudhary2014iros] discovered and modeled objects online and used them as landmarks.
- QuadricSLAM [nicholson2019quadricslam] and CubeSLAM [yang2019cubeslam] parametrize objects as quadrics or cuboids from detections.
- Fusion++ [mccormac2018fusionpp] and SemanticFusion [mccormac2017semanticfusion] build dense object-level and semantic maps.
- Bowman et al. [bowman2017probabilistic] formalized probabilistic semantic data association.
- Survey: Garg et al. [garg2020semantics].

**How we differ.** These systems are single-robot, mostly closed-vocabulary, and rarely tie object landmarks to inter-robot data association. Hivemap's landmarks carry open-vocabulary embeddings. In simulation, these are a stand-in for SAM2+CLIP features. The landmarks serve three roles at once: SLAM landmarks, inter-robot loop-closure anchors, and the queryable "knowledge" the LLM agents use. Choudhary et al. 2017 [choudhary2017ijrr] already combined object landmarks with distributed mapping. Our step is open-vocabulary object identity plus aliasing-aware verification, exposed to language agents.

### 3. Open-vocabulary 3D maps and scene graphs

**What exists.**

*Foundation models.* CLIP [radford2021clip], SAM [kirillov2023sam] and SAM 2 [ravi2025sam2].

*Dense open-vocabulary 3D features.* OpenScene [peng2023openscene], ConceptFusion [jatavallabhula2023conceptfusion], LERF [kerr2023lerf] and OpenMask3D [takmaz2023openmask3d].

*Navigation-oriented maps.* VLMaps [huang2023vlmaps], CoWs [gadre2023cows] and VLFM [yokoyama2024vlfm].

*3D scene graphs.*
- Armeni et al. [armeni2019scenegraph], 3D dynamic scene graphs [rosinol2020dsg] and Hydra [hughes2022hydra].
- Open-vocabulary and task-driven variants: ConceptGraphs [gu2024conceptgraphs] **[core]**, HOV-SG [werby2024hovsg] and Clio [maggio2024clio].

*Multi-robot.*
- Hydra-Multi [chang2023hydramulti] **[core]** builds 3D scene graphs collaboratively.
- D-Lite [chang2023dlite] **[core]** compresses scene graphs for navigation-oriented multi-robot sharing.
- MR-COGraphs [gu2025mrcographs] **[core]** builds and shares open-vocabulary object scene graphs across robots, compressing features to cut transmitted data by more than 80%.

**How we differ.** This is the closest *mapping* line of work.
- MR-COGraphs and Hydra-Multi already build multi-robot (open-vocabulary) object maps and care about bandwidth.
- They do not put LLM agents in the loop as consumers and controllers of the map.
- They do not compare map sharing against natural-language communication on embodied team tasks.
- They do not evaluate verification against perceptual aliasing as a guard against *false shared beliefs* driving downstream actions.

Hivemap should present its map representation as deliberately simple (object landmarks + embeddings). The contribution is the *comparison and integration*, not a better open-vocabulary mapper.

### 4. LLMs for robot planning and embodied agents

**What exists.**

*Grounded planning.*
- Value-based affordance grounding: SayCan [ahn2022saycan].
- Code generation: Code as Policies [liang2023cap] and ProgPrompt [singh2023progprompt].
- Closed-loop feedback: Inner Monologue [huang2022innermonologue].
- Few-shot replanning: LLM-Planner [song2023llmplanner].
- Planning over 3D scene graphs: SayPlan [rana2023sayplan] **[core]**.
- Spatial value maps: VoxPoser [huang2023voxposer].

*End-to-end VLAs.* RT-2 [brohan2023rt2], OpenVLA [kim2024openvla] and pi0 [black2025pi0].

*Agent patterns.* ReAct reasoning+acting [yao2023react], tool use [schick2023toolformer] and lifelong skill libraries [wang2023voyager].

**How we differ.** Hivemap's agents follow the ReAct/tool-calling pattern with a fixed, JSON-schema-constrained tool set (explore, exchange_map, optimize, search, message, navigate). SayPlan is the closest single-agent analogue, since it grounds an LLM in a 3D scene graph. Hivemap differs in three ways:
1. The graph/map is *built and merged by the team at run time* rather than given.
2. There are many agents.
3. The agents are small open models running in the browser rather than frontier API models.

We do not train policies and do not compete with VLAs. Low-level navigation is classical.

### 5. LLM multi-agent and multi-robot coordination

**What exists.**

*Multi-robot LLM planning.*
- RoCo [mandi2024roco] **[core]**: dialectic negotiation between per-robot LLMs in natural language, for manipulation.
- SMART-LLM [kannan2024smartllm] **[core]**: centralized decomposition, coalition formation and allocation.
- COHERENT [liu2025coherent]: proposal-execution-feedback loops for heterogeneous teams.
- Chen et al. [chen2024scalable] **[core]**: directly compare centralized, decentralized and hybrid LLM communication frameworks and report token cost and success as team size grows.

*Embodied cooperation through language messages.*
- CoELA [zhang2024coela] **[core]**: a modular perception/memory/communication/planning agent that decides *what to say* to teammates in TDW-MAT and C-WAH. It finds that language communication helps, and that LLM-generated messages are often redundant or unhelpful.
- Organized teams [guo2024organized]: imposing structure on LLM teams changes communication efficiency.
- Theory-of-mind analysis [li2023tom]: belief tracking and its failures in LLM teams.
- MindAgent [gong2023mindagent]: LLM multi-agent coordination in games.

*Shared maps with LLMs/VLMs for multi-robot search.*
- Co-NavGPT [yu2023conavgpt] **[core]**: a VLM assigns frontiers over a merged semantic map.
- MCoCoNav [shen2025mcoconav]: a global semantic map serves as the communication channel.
- COMRES-VLM / LLM-MCoX [wang2025comresvlm] **[core]**: a VLM coordinates exploration and search over a shared occupancy map.
- Murata et al. [murata2025multiobject] **[core]**: LLM planning with *distributed on-site knowledge* (per-robot spatial concepts) for multi-object retrieval.
- DuoMind [zhou2026duomind]: robots coordinate through natural-language "semantic communication".

*General multi-agent LLM frameworks.* CAMEL [li2023camel], AutoGen [wu2023autogen] and generative agents [park2023generative].

*Learned/emergent communication.* Foerster et al. [foerster2016learning] and Lazaridou et al. [lazaridou2017emergence].

*Survey.* Li et al. [li2025llmmrssurvey].

**How we differ.** This is the closest *agent* line of work. Existing papers usually fix one communication channel:
- natural language (RoCo, CoELA, DuoMind), or
- a shared map assumed correct and usually centrally fused, with known poses (Co-NavGPT, MCoCoNav, COMRES-VLM).

Chen et al. vary the *architecture* (centralized vs decentralized dialogue), not the *medium*.

Hivemap holds the agents, tools, tasks and environments fixed and varies only the knowledge-sharing medium: none vs natural language vs a verified shared map. The shared map is not assumed. It is constructed with unknown relative frames through encounters, verified matches and distributed optimization, so errors and verification failures are part of the measured pipeline. This gives a direct test of a question that CoELA and the LLM-MRS survey raise but do not isolate: is free-form language an efficient and reliable carrier of *spatial* knowledge for small-model agents, compared with a structured, verifiable map?

### 6. Multi-robot task allocation, exploration, communication constraints

**What exists.**
- Taxonomies: Gerkey & Matarić [gerkey2004taxonomy] **[core]** and Korsah et al. [korsah2013taxonomy].
- Market/auction-based allocation: [dias2006market] **[core]**, consensus-based bundle auctions [choi2009cbba], and auctions under limited communication [otte2020auctions].
- Coordinated frontier exploration: [yamauchi1998frontier, burgard2005coordinated] **[core]**.
- Survey of communication-restricted exploration: [amigoni2017commrestricted].

**How we differ.** Hivemap's dispatcher is a classical cost-based allocator. In Gerkey-Matarić terms it is an ST-SR-IA/TA assignment by path cost over the shared map. We claim no novelty in allocation. The point is that classical allocation *becomes available* once robots share a metrically consistent map: with only language messages, path costs to remote objects cannot be computed. Classical communication-constrained work treats the channel as a constraint to plan around. We treat the *content* of the channel (language vs map) as the experimental variable.

### 7. Benchmarks and simulators

**What exists.**
- Habitat [savva2019habitat] and Habitat 3.0 [puig2024habitat3] (human-robot collaboration); PARTNR [chang2025partnr] **[core]** (LLM planning in multi-agent household tasks).
- ThreeDWorld [gan2021tdw] and its Transport Challenge [gan2021tdwtransport]. TDW-MAT, CoELA's multi-agent variant, builds on these.
- ALFRED [shridhar2020alfred], BEHAVIOR-1K [li2022behavior1k], Watch-And-Help [puig2021wah] and multi-agent embodied QA [tan2020maeqa].

**How we differ.** These benchmarks mostly have 1-2 agents, assume shared or known global frames, or provide privileged object states. None measures the cost of building a *shared* map from scratch. Hivemap's simulated buildings with up to 10 robots are lightweight and lack photorealism. They should be presented as a controlled testbed for the communication question, not as a rival benchmark. Reviewers will ask how results would transfer to Habitat or PARTNR-style environments.

### 8. On-device LLMs and structured decoding

**What exists.**
- In-browser inference with WebGPU: WebLLM [ruan2024webllm].
- Small open models: Qwen2.5 [qwen2024qwen25].
- Constrained/structured generation: XGrammar [dong2025xgrammar], Outlines [willard2023outlines] and grammar-constrained decoding [geng2023gcd].

**How we differ.** Most LLM multi-robot papers use GPT-4-class API models. Hivemap runs one small open model per robot, in the browser, with schema-constrained tool calls. This is a practical contribution (cheap, reproducible, no API) and also a confound. Communication results may depend on model size: small models may write worse messages. This should be stated, and ideally checked with at least one larger model.

---

## (b) The 15 most relevant works

| # | Work | One-line summary | Key difference from Hivemap |
|---|---|---|---|
| 1 | Choudhary et al. 2017 [choudhary2017ijrr] | Distributed two-stage DGS mapping with privacy/communication constraints; object-based models cut bandwidth. | Hivemap reuses this back-end. New: open-vocab objects, encounter-seeded merging with verification, and LLM agents that decide when to exchange and optimize. Evaluated on task success, not only accuracy. |
| 2 | Choudhary et al. 2016 [choudhary2016icra] | Introduces the two-stage distributed Gauss-Seidel trajectory estimator. | Back-end reused, not claimed as a contribution. |
| 3 | Kimera-Multi [tian2022kimeramulti] | Robust, distributed, dense metric-semantic SLAM (GNC + distributed PGO). | Closed-set semantics, no language agents, no comparison with NL communication. |
| 4 | Swarm-SLAM [lajoie2024swarmslam] | Sparse decentralized C-SLAM with budgeted inter-robot loop closures and PCM/GNC. | Geometric/appearance map, not a queryable object knowledge base for agents. |
| 5 | Hydra-Multi [chang2023hydramulti] | Multi-robot online 3D scene-graph construction and merging. | No LLM agents. Evaluates map quality, not team task performance vs language messaging. |
| 6 | MR-COGraphs [gu2025mrcographs] | Communication-efficient multi-robot *open-vocabulary* object scene graphs. | Closest map representation. No agents, tasks or comparison with NL; Hivemap adds aliasing-verified matching and agent-driven exchange. |
| 7 | D-Lite [chang2023dlite] | Navigation-oriented compression of 3D scene graphs for multi-robot sharing. | Optimizes *what map to send*; Hivemap compares *map vs language* as the medium. |
| 8 | Data-efficient decentralized visual SLAM [cieslewski2018icra] | Bandwidth-efficient decentralized place recognition and optimization. | Classical pipeline; Hivemap's sharing is triggered by agent tool calls and evaluated downstream. |
| 9 | CoELA [zhang2024coela] | Modular LLM agents that cooperate via NL messages in TDW-MAT / C-WAH. | Language is the only channel, and agents share a known frame. Hivemap adds a verified-map channel and compares the two directly. |
| 10 | Chen et al. 2024 [chen2024scalable] | Compares centralized/decentralized/hybrid LLM multi-robot communication frameworks. | Varies the architecture of dialogue; Hivemap varies the medium (none / NL / map). |
| 11 | RoCo [mandi2024roco] | Per-robot LLMs negotiate plans in natural language. | Manipulation with full observability and no mapping; NL is the only channel. |
| 12 | SMART-LLM [kannan2024smartllm] | LLM task decomposition, coalition formation and allocation. | Centralized, assumes a known world state; Hivemap must build that state collaboratively. |
| 13 | SayPlan [rana2023sayplan] | Single LLM plans over a given large 3D scene graph. | Single agent, graph given a priori; Hivemap's graph/map is built and merged online by many agents. |
| 14 | Co-NavGPT [yu2023conavgpt] / MCoCoNav [shen2025mcoconav] | VLM/LLM coordinates multi-robot semantic navigation over a merged global semantic map. | Assumes known poses and correct fusion; no NL baseline, no verification. Hivemap measures how the map was obtained and whether it can be trusted. |
| 15 | COMRES-VLM (LLM-MCoX) [wang2025comresvlm] | VLM coordinates multi-robot exploration and search over a shared occupancy map. | Centralized planner with an assumed shared map; Hivemap uses decentralized per-robot agents and compares channels. |

Also close, and worth citing next to rows 9-15: Murata et al. [murata2025multiobject], which uses distributed per-robot knowledge for LLM multi-object retrieval and so overlaps our fetch/inventory tasks, and ConceptGraphs [gu2024conceptgraphs], the single-robot open-vocab object graph that Hivemap's object map approximates.

---

## (c) References dropped or not included

**Not verified, so dropped:**
- **CURB-OSG** (Steinke, Büchner, Vödisch, Valada; collaborative open-vocabulary dynamic 3D scene graphs for urban driving). It appeared in web-search snippets, but an arXiv title query returned no match and I could not confirm the ID or venue.
- **"Communication-Efficient Digital-Twin Coordination for Heterogeneous LLM Embodied Agents over Computing Power Networks" (LDT-Coord).** It is highly relevant: structured primitives replace NL negotiation, with about 70x less communication. But a search snippet was all I found, with no confirmed arXiv ID, authors or date. Worth re-checking by hand, because a reviewer could cite it as prior evidence that structured beats NL.
- **KGLAMP** (knowledge-graph-guided LLM multi-robot planning on MAT-THOR). Snippet only, not verified.
- **GoalSwarm** (multi-UAV open-vocabulary navigation). Snippet only, not verified.
- **Isaac Sim.** No canonical archival paper to cite; use a URL footnote if needed.

**Verified but left out for length** (can be added on request):
- GoalVLM (arXiv:2603.18210, multi-agent VLM object-goal navigation with a fused BEV map)
- Kimera (Rosinol et al., ICRA 2020, arXiv:1910.02490)
- Hughes et al. IJRR "Foundations of Spatial Perception for Robotics" (arXiv:2305.07154)
- Rosen et al. "Advances in Inference and Representation for SLAM" (arXiv:2103.05041)
- CommNet (Sukhbaatar et al., arXiv:1605.07736)
- Habitat 2.0 (arXiv:2106.14405)
- TVM (arXiv:1802.04799)
- DDF-SAM 2.0 (ICRA 2013, DOI 10.1109/ICRA.2013.6631323)
- Group-k consistent measurement set maximization (Forsgren et al., IJRR 2024, DOI 10.1177/02783649241256970)
- Multi-UAV collaborative monocular SLAM (Schmuck & Chli, ICRA 2017).

**Venue caveats** (cited as arXiv because I did not confirm a venue): Voyager, MindAgent, AutoGen, Co-NavGPT, COMRES-VLM, Murata et al., DuoMind, Guo et al., WebLLM, Qwen2.5, Outlines, TDW Transport Challenge. Clio is listed as RA-L 2024 without volume or pages; add them if needed. If you know the final venue of any of these, update the entry.

**Note on COMRES-VLM:** arXiv 2509.26324 was first posted as "LLM-MCoX: Large Language Model-based Multi-robot Coordinated Exploration and Search" and later retitled (v3). The bib entry uses the current title and records the old one in `note`.

---

## (d) Closest prior work and honest positioning

**What a reviewer will compare against:**
1. **CoELA [zhang2024coela] and Chen et al. [chen2024scalable].** These are the LLM-team communication papers. Reviewers will ask whether our NL baseline is as strong as CoELA's communication module, and whether we control for message budget and token cost the way Chen et al. do.
2. **Co-NavGPT / MCoCoNav / COMRES-VLM.** These already give LLM/VLM planners a shared semantic map. Reviewers will say "LLM + shared map for multi-robot search exists." Our answer: those systems *assume* a correctly fused global map with known poses and never compare against language. We build the map under unknown relative frames and measure the effect of verification.
3. **MR-COGraphs / Hydra-Multi / Kimera-Multi.** For the map itself, reviewers will note that multi-robot open-vocabulary object maps with bandwidth control exist and are more mature, with real sensors and real SAM/CLIP features. Our simulated stand-in features are a clear weakness on this axis.
4. **Choudhary et al. 2016/2017.** The back-end is theirs. It must be cited as such and not presented as a contribution. Object-based distributed mapping is also theirs.
5. **SayPlan / ConceptGraphs.** These ground single-agent LLM planning in a scene graph. Our multi-agent, built-online setting is the difference.

**What is novel (defensible claims):**
- A **controlled comparison of the knowledge-sharing medium** for LLM robot teams: none vs natural language vs a verified shared object map. Agents, tools, tasks and environments are held fixed. Five task families, up to 10 robots. To our knowledge no prior paper isolates this variable. Chen et al. vary architecture; CoELA uses NL only; the shared-map papers use a map only.
- **Map construction exposed as agent tools.** The LLM decides when to explore, exchange maps, optimize, search, message or navigate, so the cost of building the shared map (encounters, failed verifications, optimization rounds) is part of what is measured, not assumed away.
- **Verification as protection against false shared beliefs.** Anti-aliasing checks on cross-robot object matches are evaluated through their *downstream* effect on task success, for example a wrong merge sending a robot to the wrong room. A map-without-verification ablation is the right way to show this.
- **Small, in-browser open models** (Qwen2.5 via WebLLM with schema-constrained tool calls). This is a reproducible, zero-API setting that is uncommon in this literature.

**What is not novel (should be stated plainly):**
- Distributed two-stage PGO (DGS/SOR), object-based distributed mapping, encounter-based map merging, and consistency-checked loop closures. These are all established ([choudhary2016icra, choudhary2017ijrr, zhou2006rendezvous, mangelson2018pcm, yang2020gnc]).
- Open-vocabulary object maps and multi-robot scene graphs ([gu2024conceptgraphs, chang2023hydramulti, gu2025mrcographs]).
- Cost-based task allocation ([gerkey2004taxonomy, dias2006market]).
- The ReAct/tool-calling agent pattern ([yao2023react, schick2023toolformer]) and JSON-schema constrained decoding ([dong2025xgrammar, willard2023outlines]).

**Threats to validity to own in the paper:**
1. Simulated buildings and stand-in embeddings instead of real SAM2+CLIP. Aliasing statistics may differ on real data.
2. The NL baseline may be weak *because* models are small. Include a larger model, or a CoELA-style message template, as a check.
3. Bandwidth and tokens: report bytes and tokens per channel (cf. [cieslewski2018icra, chang2023dlite, gu2025mrcographs, chen2024scalable]), so "map beats language" is not simply "more information beats less."
4. Add an oracle upper bound (ground-truth shared map) and a no-verification ablation, so readers can separate the value of *sharing* from the value of *verified* sharing.

**Suggested positioning sentence.** "Rather than proposing a new collaborative SLAM back-end or a new LLM planner, we ask which *medium* LLM robot teams should use to share knowledge. We show that a shared, verified object map built with established distributed object-based SLAM [choudhary2017ijrr] gives small on-device LLM agents grounding that natural-language messaging [zhang2024coela, mandi2024roco] does not. We quantify when and why, including the cost of building the map and the role of match verification."
