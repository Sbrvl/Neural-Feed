# NeuralFeed Scoring Methodology

This document explains how NeuralFeed converts `TRIBE v2` cortical predictions into a transparent, literature-informed score.

It follows the full thread:

1. what `TRIBE v2` outputs
2. what those outputs can plausibly tell us
3. how we map them to cortical systems
4. how we derive interpretable metrics
5. how we aggregate those metrics into a final score
6. what the score does and does not mean

This is the scientific and mathematical source of truth for the current scoring model implemented in [hf_space/parcellation.py](./hf_space/parcellation.py).

## 1. The Basic Problem

NeuralFeed is trying to measure whether a piece of content looks more like:

- cognitively engaging, structured, and reflective
- mixed / ambiguous
- sensory-dominant, fragmented, and passively consumable

We use the phrase `brain rot score` as a product label, but the underlying scientific construct is more conservative:

`Predicted cortical engagement vs passive-risk balance`

That wording matters.

We are not measuring:

- individual brain health
- dopamine directly
- nucleus accumbens activity
- addiction in a clinical sense
- diagnostic mental states

We are measuring a composite proxy built from cortical response patterns that `TRIBE v2` predicts on a standard cortical surface.

## 2. What TRIBE v2 Actually Gives Us

`TRIBE v2` is a multimodal brain encoding model. Given video, audio, or text-derived input, it predicts fMRI-like responses on the `fsaverage5` cortical mesh.

Per the `TRIBE v2` model card:

- predictions are for an `"average" subject`
- outputs live on the `fsaverage5` cortical mesh
- output shape is `(n_timesteps, n_vertices)`
- the mesh has about `20k` cortical vertices

Primary source:

- TRIBE v2 model card: https://huggingface.co/facebook/tribev2

This means the raw object we start from is:

```text
preds[t, v]
```

where:

- `t` is time
- `v` is a cortical surface vertex

This is enough to reason about large-scale cortical systems.

It is not enough to claim direct measurement of specific subcortical reward circuitry.

## 3. Scientific Framing

The score is built around large-scale cortical systems that are well established in the literature.

### 3.1 Default Mode vs Task-Positive / Control Systems

Fox et al. (2005) showed that the brain contains large-scale systems with dynamic antagonism, especially default-mode and task-positive systems.

This is the starting point for the idea that organized cognitive engagement should show structured large-scale coordination, not random drift.

Primary source:

- Fox et al. 2005, PNAS: https://pubmed.ncbi.nlm.nih.gov/15976020/

### 3.2 DMN Is Not "Bad"

The DMN is not a junk signal. Menon (2023) summarizes strong evidence that the DMN supports internal narrative, semantic integration, autobiographical and self-referential processing.

That means:

- low DMN is not automatically "good"
- high DMN is not automatically "brain rot"
- what matters is how DMN interacts with control systems and how organized the dynamics are

Primary source:

- Menon 2023, Neuron: https://pubmed.ncbi.nlm.nih.gov/37167968/

### 3.3 DMN and Control Can Cooperate

Beaty et al. (2015) showed that default and executive systems can couple during creative cognition.

That is why NeuralFeed does not reward only anticorrelation. It allows for two healthy patterns:

- focused external control
- structured reflective / narrative engagement

Primary source:

- Beaty et al. 2015, Scientific Reports: https://pubmed.ncbi.nlm.nih.gov/26084037/

### 3.4 Salience Is About Relevance and Attention Capture

The salience network is classically linked to detecting and prioritizing behaviorally relevant internal and external events.

This is useful for our problem because some content is designed to constantly capture attention. But this is still a cortical attention-capture story, not a dopamine story.

Primary sources:

- Seeley et al. 2007, J Neurosci: https://pubmed.ncbi.nlm.nih.gov/17329432/
- Menon 2011, Trends in Cognitive Sciences: https://pubmed.ncbi.nlm.nih.gov/21908230/
- Seeley 2019, J Neurosci: https://pubmed.ncbi.nlm.nih.gov/31676604/

### 3.5 Why a Cortical Atlas?

TRIBE outputs predictions on the cortical mesh. To turn those vertex-level predictions into interpretable large-scale signals, we aggregate them using a cortical parcellation.

We currently use the `Schaefer 2018` parcellation in `7-network` form because it aligns naturally with large-scale cortical systems.

Primary source:

- Schaefer et al. 2018, Cerebral Cortex: https://pubmed.ncbi.nlm.nih.gov/28981612/

## 4. What We Map TRIBE Outputs Into

The implementation maps vertices into these cortical systems:

- `DMN` -> Schaefer `Default`
- `FPN / executive` -> Schaefer `Cont`
- `Dorsal attention` -> Schaefer `DorsAttn`
- `Visual` -> Schaefer `Vis`
- `Somatomotor` -> Schaefer `SomMot`
- `Salience` -> Schaefer `SalVentAttn`

Important note:

The current Schaefer-7 setup does **not** give us a clean language network or a clean auditory network. So the current model avoids pretending that it has them.

That is a deliberate honesty decision.

## 5. Why We Do Not Claim More Than This

There are two key constraints:

### 5.1 TRIBE is population-average, not individual truth

The output is a predicted response for an average subject, not the actual user.

### 5.2 The mesh is cortical

The current inference path is cortical-surface based. That means we should not claim:

- nucleus accumbens measurement
- dopamine measurement
- direct addiction readout

Instead we use language like:

- `salience`
- `attention capture`
- `sensory dominance`
- `passive-risk`

Those are the strongest claims we can defend from these outputs.

## 6. The Mathematical Pipeline

## 6.1 Input

Start from:

```text
preds ∈ R^(T x V)
```

where:

- `T` = number of timesteps
- `V` = number of cortical vertices, padded or trimmed to `20484`

## 6.2 Network Timeseries

For each network `N`, compute the mean response across all vertices assigned to that network:

```text
N(t) = mean(preds[t, vertices_in_N])
```

This gives us:

- `dmn_ts`
- `exec_ts`
- `visual_ts`
- `somot_ts`
- `dorsal_attn_ts`
- `salience_ts`

## 6.3 Composite Latent Signals

### Control signal

We use a control composite that mixes executive control and dorsal attention:

```text
control_ts = 0.65 * exec_ts + 0.35 * dorsal_attn_ts
```

Rationale:

- frontoparietal control should dominate
- dorsal attention contributes task-positive focus
- both are cortical systems we can justify with the atlas we have

### Sensory signal

We use a sensory composite that depends on modality:

For audiovisual mode:

```text
sensory_ts = 0.70 * visual_ts + 0.30 * somot_ts
```

For audio mode:

```text
sensory_ts = 0.20 * visual_ts + 0.80 * somot_ts
```

Rationale:

- visual dominates when video is real
- in audio-only mode we stop pretending visual dynamics mean much
- `somatomotor` is used as the best available sensory-adjacent cortical proxy in the current atlas

## 6.4 Stable Feature Magnitudes

We use RMS magnitude rather than raw mean because signed cortical predictions can average toward zero:

```text
rms(x) = sqrt(mean(x^2))
```

This gives:

- `dmn_power`
- `exec_power`
- `control_power`
- `visual_power`
- `somot_power`
- `salience_power`
- `sensory_power`

We also compute temporal variability:

```text
std(x)
```

for:

- `dmn_var`
- `control_var`
- `salience_var`
- `sensory_var`

and define:

```text
cognitive_var = control_var + 0.5 * dmn_var
```

This says cognitive richness is mainly about structured control dynamics, with some contribution from internal / default-mode dynamics.

## 6.5 Core Derived Metrics

### 1. Network Coordination

```text
corr_val = corr(dmn_ts, control_ts)
network_coordination = |corr_val|
```

Interpretation:

- high absolute correlation means the large-scale systems are organized
- negative correlation can reflect focused task-positive engagement
- positive correlation can reflect internally structured reflective / narrative engagement
- near-zero correlation suggests decoupled drift

Scientific motivation:

- Fox 2005
- Beaty 2015
- Menon 2023

### 2. Internal-Control Balance

```text
internal_control_balance =
  1 - |dmn_power - control_power| / (dmn_power + control_power + eps)
```

Interpretation:

- high if DMN and control are both meaningfully present and not wildly imbalanced
- low if one dominates completely

This explicitly avoids treating DMN as inherently bad.

### 3. Control Share

```text
control_share = control_power / (control_power + sensory_power + eps)
```

Interpretation:

- high when cortical control exceeds raw sensory drive
- low when content looks mostly sensory and not control-engaging

### 4. Cognitive Dynamism

```text
cognitive_dynamism = cognitive_var / (cognitive_var + sensory_var + eps)
```

Interpretation:

- high when higher-order dynamics carry more of the temporal structure
- low when temporal structure is dominated by sensory volatility

### 5. Sensory Dominance

```text
sensory_dominance = sensory_power / (sensory_power + control_power + eps)
```

Interpretation:

- high when the content looks sensory-heavy relative to control engagement

### 6. Sensory Fragmentation

```text
sensory_fragmentation = sensory_var / (sensory_var + cognitive_var + eps)
```

Interpretation:

- high when temporal instability is mostly sensory
- lower when dynamics are carried by higher-order cortical systems

### 7. Salience Capture

```text
salience_capture =
  (salience_power + 0.5 * salience_var) /
  (salience_power + 0.5 * salience_var + control_power + 0.5 * control_var + eps)
```

Interpretation:

- high when the signal looks attention-capturing and salience-heavy relative to control
- this is a cortical proxy for attention capture, not a direct reward-system or addiction measure

## 6.6 Composite Scores

We define two latent composites.

### Enrichment

```text
enrichment =
  0.35 * network_coordination +
  0.25 * control_share +
  0.20 * cognitive_dynamism +
  0.20 * internal_control_balance
```

Interpretation:

- organized large-scale coordination matters most
- control-over-sensory balance matters next
- cognitive dynamism and balanced internal/external processing also matter

### Passive Risk

```text
passive_risk =
  0.40 * sensory_dominance +
  0.30 * sensory_fragmentation +
  0.30 * salience_capture
```

Interpretation:

- the strongest negative signal is sensory dominance
- fragmentation and salience capture also contribute

## 6.7 Final 0-100 Enrichment Score

```text
enrichment_score = clip(50 + 50 * (enrichment - passive_risk), 0, 100)
```

Interpretation:

- `50` is the neutral midpoint
- more enrichment than passive risk pushes upward
- more passive risk than enrichment pushes downward

This is a transparent linear composite, not a trained latent model.

## 6.8 Final 0-10 Brain Rot Display Score

For UI continuity, we keep a display score:

```text
brain_rot = clip(10 - enrichment_score / 10, 0, 10)
```

Interpretation:

- `0` = more enriching / organized
- `10` = more passive-risk / sensory-dominant

This is a display inversion of the enrichment score, not a separate scientific model.

## 7. Pattern Labels

The model also produces a qualitative label.

### Sensory-dominant passive consumption

Assigned when:

```text
passive_risk >= 0.62 and network_coordination < 0.40
```

### Reflective / narrative engagement

Assigned when:

```text
corr_val >= 0.20 and
internal_control_balance >= 0.55 and
cognitive_dynamism >= 0.50
```

### Focused / task-positive engagement

Assigned when:

```text
corr_val <= -0.15 and control_share >= 0.55
```

### Mixed engagement

Assigned otherwise.

These thresholds are heuristic. They are not learned from a labeled dataset yet.

## 8. Why This Model Is More Honest Than the Old One

The old approach implicitly drifted toward claims like:

- reward measurement
- hijack / addiction measurement
- simple `DMN + reward / FPN` style reasoning

The current model is more honest because:

1. it stays on the cortical surface
2. it only uses networks we actually extract
3. it avoids fake precision about dopamine or subcortex
4. it uses interpretable ratios and shares instead of clip-specific min-max hacks
5. it distinguishes enrichment from passive-risk instead of pretending one scalar explains everything by itself

## 9. Output Fields and Their Meaning

The current API returns:

- `health_score`
  NeuralFeed's main `0-100` enrichment score
- `enrichment_score`
  Alias of `health_score`
- `brain_rot`
  UI-facing inverse `0-10` display score
- `passive_risk`
  `0-100` passive-risk composite
- `dmn`
  relative prominence of default-mode activity on a `0-10` display scale
- `fpn`
  relative prominence of frontoparietal control activity on a `0-10` display scale
- `salience`
  relative prominence of salience-network activity on a `0-10` display scale
- `reward`
  legacy alias of `salience` for backward compatibility only
- `visual`
  relative prominence of visual network activity
- `somatomotor`
  relative prominence of somatomotor network activity
- `dominant_pattern`
  qualitative label
- `correlation`
  signed `DMN-control` correlation
- `metrics`
  the underlying component metrics

Important:

The `dmn`, `fpn`, `salience`, `visual`, and `somatomotor` display values are **relative prominence scores within a clip**, not absolute calibrated neuroscientific quantities.

## 10. Current Limitations

This model is more coherent than the old one, but it still has real limitations.

### 10.1 Heuristic weights

The weights are theory-driven design choices, not fitted coefficients.

### 10.2 No calibration corpus yet

The model is not yet calibrated against a hand-labeled reference set of clips.

### 10.3 No clean language or auditory network in current atlas

That means the present version cannot fully implement a richer language/narrative model.

### 10.4 TRIBE predictions are simulated population averages

They are useful proxies, but they are not direct measurements of the user.

### 10.5 Audio-only mode is weaker

When the runtime only uses audio, any metric involving sensory structure is less informative than in a true audiovisual path.

## 11. What Future Improvements Should Look Like

The next scientifically honest improvements are:

1. add a small handpicked calibration corpus
2. collect human ratings for engagement, coherence, and passive attention-capture
3. check whether the current score ordering passes basic face-validity tests
4. move to a richer atlas if language and auditory systems are important
5. add confidence estimates based on clip length, modality, and signal stability

## 12. Plain-Language Summary

NeuralFeed does not claim to read your brain directly.

It uses `TRIBE v2` to predict how an average cortex might respond to a piece of content, then summarizes that cortical response into interpretable dimensions:

- how coordinated the large-scale networks are
- how much control engagement outweighs sensory drive
- how dynamic the cognitive systems are over time
- how fragmented the sensory response is
- how much the salience system dominates relative to control

Those dimensions are then combined into:

- an `enrichment score`
- a `passive-risk score`
- a UI-facing `brain rot score`

That is the honest claim.

## References

- TRIBE v2 model card: https://huggingface.co/facebook/tribev2
- d'Ascoli et al. 2026, *A foundation model of vision, audition, and language for in-silico neuroscience*: cited from the TRIBE v2 model card above
- Fox MD, Snyder AZ, Vincent JL, et al. 2005. *The human brain is intrinsically organized into dynamic, anticorrelated functional networks.* PNAS. https://pubmed.ncbi.nlm.nih.gov/15976020/
- Menon V. 2023. *20 years of the default mode network: A review and synthesis.* Neuron. https://pubmed.ncbi.nlm.nih.gov/37167968/
- Beaty RE, Benedek M, Kaufman SB, Silvia PJ. 2015. *Default and Executive Network Coupling Supports Creative Idea Production.* Scientific Reports. https://pubmed.ncbi.nlm.nih.gov/26084037/
- Seeley WW, Menon V, Schatzberg AF, et al. 2007. *Dissociable intrinsic connectivity networks for salience processing and executive control.* J Neurosci. https://pubmed.ncbi.nlm.nih.gov/17329432/
- Menon V. 2011. *Large-scale brain networks and psychopathology: a unifying triple network model.* Trends Cogn Sci. https://pubmed.ncbi.nlm.nih.gov/21908230/
- Seeley WW. 2019. *The Salience Network: A Neural System for Perceiving and Responding to Homeostatic Demands.* J Neurosci. https://pubmed.ncbi.nlm.nih.gov/31676604/
- Schaefer A, Kong R, Gordon EM, et al. 2018. *Local-Global Parcellation of the Human Cerebral Cortex from Intrinsic Functional Connectivity MRI.* Cerebral Cortex. https://pubmed.ncbi.nlm.nih.gov/28981612/
