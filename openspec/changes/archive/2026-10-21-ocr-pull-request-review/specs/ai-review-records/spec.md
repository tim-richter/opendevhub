## MODIFIED Requirements

### Requirement: Review runs are stored

Each time AI review findings are generated, the system SHALL store a review with the pull request, the head commit the request was checked against, the session, the review task, the mode (`session`, `quick` or `ocr`), the summary, the findings and the creation time. When the findings cannot be parsed, it SHALL store nothing. An `ocr` review SHALL have no session. Its task SHALL be the task whose variant owns the reviewed checkout, and it SHALL have no task when no variant owns the checkout. A finding that carries a `category` or a `suggestion` SHALL keep both when it is stored.

#### Scenario: Findings generated

- **WHEN** the AI review of pull request #12 at commit `abc123` returns a summary and three findings
- **THEN** a review row for #12 at `abc123` holds that summary and those three findings

#### Scenario: Unparseable reply

- **WHEN** the model's reply has no valid findings JSON
- **THEN** the request fails as before and no review is stored

#### Scenario: OCR review stored

- **WHEN** an OCR review of pull request #12 at commit `abc123` returns two comments
- **THEN** a review row with mode `ocr`, no session, and those two findings, including their categories and suggestions, is stored

### Requirement: Earlier reviews are listed

The system SHALL list a pull request's stored reviews, newest first. The pull request page SHALL show them with their engine (agent, quick or OCR), commit, time, summary and finding count. It SHALL mark those made against an older head commit as outdated, and let the user open a review's findings in the diff.

#### Scenario: Reopening a PR

- **WHEN** the user opens pull request #12 after an AI review was run on it yesterday
- **THEN** the page lists that review with its summary and finding count

#### Scenario: PR updated since

- **WHEN** pull request #12 has new commits after a review
- **THEN** that review is marked outdated

#### Scenario: OCR review listed

- **WHEN** pull request #12 has an OCR review and an agent review
- **THEN** each list entry shows which engine produced it
