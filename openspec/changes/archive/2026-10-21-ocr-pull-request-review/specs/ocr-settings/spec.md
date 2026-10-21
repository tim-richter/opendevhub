## ADDED Requirements

### Requirement: Open Code Review settings section

The settings modal SHALL have an **Open Code Review** section in the Integrations group. The section SHALL be found by settings search for "ocr", "review", "model", "provider", "api key", "timeout", "concurrency" and "budget". It SHALL edit the default provider configuration that every project uses unless the project overrides it:

- a preset, one of OCR's built-in providers for the bundled version or Custom
- a base URL
- a protocol (`anthropic`, `openai` or `openai-responses`)
- a model
- an API key

Choosing a preset SHALL fill in its base URL and protocol, and both SHALL stay editable. The section SHALL show the bundled OCR version.

#### Scenario: Picking a preset

- **WHEN** the user picks the `deepseek` preset
- **THEN** the base URL becomes `https://api.deepseek.com` and the protocol `openai`

#### Scenario: Custom provider

- **WHEN** the user picks Custom and enters `https://ask-ai.example.com/api`, protocol `openai`, and model `vllm/coding`
- **THEN** those values are saved as the configuration

### Requirement: The API key stays secret

The system SHALL store the API key in the OS credential store and keep only an opaque reference in its settings file. No API response, log line or command line SHALL contain the key. The settings SHALL report only whether a key is saved. Saving without a new key SHALL keep the saved key. The user SHALL be able to replace or remove the key.

#### Scenario: Reading settings

- **WHEN** the web app loads the OCR settings after a key was saved
- **THEN** the response says a key is saved and does not contain it

#### Scenario: Removing the key

- **WHEN** the user removes the key
- **THEN** the secret is deleted, and OCR counts as not configured

### Requirement: Settings are validated

The base URL SHALL be HTTPS, or HTTP on a loopback host. It SHALL have no credentials, query or fragment. The model SHALL be non-empty. OCR SHALL count as configured only when the base URL, protocol, model and key are all set.

#### Scenario: Plain HTTP to a remote host

- **WHEN** the user saves `http://llm.example.com/v1`
- **THEN** the save fails with a message to use HTTPS

### Requirement: Testing the connection

Both the global section and the project block SHALL offer **Test connection**. It runs the bundled `ocr llm test` on the opendevhub host with the entered values. When no new key was entered, it uses the saved key, which for a project means its own key, then the default key. It SHALL show success or the CLI's trimmed error.

#### Scenario: Wrong key

- **WHEN** the user tests with an invalid key
- **THEN** the section shows the provider's authentication error from `ocr llm test`

### Requirement: Importing an existing OCR config

When the host user's `~/.opencodereview/config.json` exists, the global section SHALL offer to import it. Import SHALL take only the active provider, never the others: a built-in preset with its key, or a custom provider's URL, protocol, model and key. Import SHALL only fill in the form. Saving the form SHALL move the key into the credential store.

#### Scenario: Importing a custom provider

- **WHEN** the host config's active provider is the custom provider `askai` with an OpenAI-protocol URL, model and key
- **THEN** the form shows Custom with that URL, protocol and model, and a key ready to save

### Requirement: Global review limits

The Open Code Review section SHALL hold review limits that apply to every OCR run:

| Limit                         | Default    |
| ----------------------------- | ---------- |
| concurrency                   | 8          |
| per-file timeout              | 15 minutes |
| token budget, 0 for unlimited | 0          |
| run limit                     | 30 minutes |

The run limit SHALL be longer than the per-file timeout. Every run SHALL pass the limits to OCR, and the run limit SHALL be the timeout of the whole run.

#### Scenario: Lower concurrency

- **WHEN** the user sets concurrency to 2
- **THEN** the next OCR review runs with `--concurrency 2`

#### Scenario: Invalid limits

- **WHEN** the user sets a 20-minute per-file timeout with a 15-minute run limit
- **THEN** the save fails and says the run limit must be longer

### Requirement: Project override

A project's settings SHALL offer an **Open Code Review** block next to its Jira and Forgejo links. The block SHALL offer two choices:

- **Use the default**, which is the initial choice and shows the default provider and model.
- **Use its own provider**, with the same provider fields as the global section.

A project's own API key SHALL be optional. Without one, the default key SHALL be used. The override SHALL be stored with the project's settings, and its key SHALL be in the OS credential store. Removing the project SHALL delete that secret.

#### Scenario: Different model, same provider

- **WHEN** the project `shop` overrides only the model to a stronger one and leaves its key empty
- **THEN** OCR reviews in `shop` use that model with the default provider's URL and key

#### Scenario: Separate account

- **WHEN** the project `work-api` uses its own provider with the company gateway URL and its own key
- **THEN** OCR reviews in `work-api` use the gateway and that key, and other projects keep the default

### Requirement: Effective provider

Each OCR review SHALL use the provider of the project it runs in. That is the project's override when it has one, and the default otherwise, with a missing override key falling back to the default key. OCR SHALL count as configured for a project only when the effective base URL, protocol, model and key are all set. The review dialog SHALL name the effective model and whether it comes from the project.

#### Scenario: Nothing configured globally, project configured

- **WHEN** there is no default provider but `work-api` has its own complete provider
- **THEN** OCR is available in `work-api` and not in other projects
