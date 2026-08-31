-- Persist one revision-bound Oduno-versus-Zenki Skill requirement conflict
-- without persisting or starting the proposed plan itself.

CREATE TABLE enno_skill_set_recoveries (
    run_id TEXT NOT NULL REFERENCES enno_contracts(run_id) ON DELETE CASCADE,
    contract_revision INTEGER NOT NULL CHECK (
        typeof(contract_revision) = 'integer' AND contract_revision >= 1
    ),
    plan_digest TEXT NOT NULL CHECK (
        length(plan_digest) = 64 AND plan_digest NOT GLOB '*[^0-9a-f]*'
    ),
    oduno_requirements_json TEXT NOT NULL,
    zenki_requirements_json TEXT NOT NULL,
    difference_json TEXT NOT NULL,
    recommended_action TEXT NOT NULL CHECK (
        recommended_action IN ('use_zenki_skill_set', 'revalidate_skill_sets')
    ),
    decision TEXT CHECK (
        decision IS NULL OR decision IN (
            'use_oduno_skill_set', 'use_zenki_skill_set',
            'revalidate_skill_sets', 'cancel'
        )
    ),
    consumed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, contract_revision),
    CHECK (consumed_at IS NULL OR decision IN ('use_oduno_skill_set', 'use_zenki_skill_set'))
);

CREATE INDEX idx_enno_skill_set_recoveries_pending
ON enno_skill_set_recoveries(run_id, contract_revision, decision, consumed_at);
