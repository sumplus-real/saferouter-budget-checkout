# SafeRouter Budget Checkout

SafeRouter generates English storefront cards from product records. A buyer approves a budget once. The seller captures only the price of the cards that pass the declared checks, or voids the authorization when none pass. Each card costs five US cents in this Sandbox demo.

## Start the workbench

Use Node.js 20.19 or newer. The checkout app has no npm dependencies.

```sh
npm test
npm start
```

Open [the local workbench](http://127.0.0.1:4188/). Choose **Load sample**, **Freeze quote**, **Create approval**, and **Simulate approval and run**. The default mode simulates generation and payment. Select **Add labeled test faults to model output** before freezing the quote to exercise failed and repaired rows. Upload `fixtures/all-rejected.json` to exercise the separate zero-charge path.

Each input is an array of up to ten objects. See [the sample](fixtures/ten-products.json) for the required ID, product name, numeric specification, unit, item price in cents, and stock. Optional fields are `availability`, `notes`, `prohibited`, `sourceLanguage`, and `requiredTitleTerms`. Set a language tag for non-English names and supply known English terms when product identity depends on a specific category or material. Try [the mixed input](fixtures/unseen-mixed.json) to check empty fields, conflicting availability, instruction-like notes, and new product names.

## Use a local model

Start a local [Ollama](https://docs.ollama.com/macos) server with cloud features disabled. Download the public [Qwen3 4B Instruct model](https://ollama.com/library/qwen3:4b-instruct) once. The model runs without API credentials or a paid inference endpoint.

```sh
OLLAMA_NO_CLOUD=1 ollama serve
# From a second terminal
ollama pull qwen3:4b-instruct
MODEL_MODE=ollama OLLAMA_MODEL=qwen3:4b-instruct npm start
```

If Ollama uses a different loopback port, set `OLLAMA_PORT`. A local LM Studio server can use `MODEL_MODE=lmstudio`, `LMSTUDIO_MODEL`, and `LMSTUDIO_PORT`. Load that model with a 2,048-token context. Ollama was used for the measured runs.

The first attempt uses structured output. A failed card gets at most one repair. When only the copy fails the prose checks, the repair asks the model for new prose and preserves the previously checked facts. SafeRouter validates the full card again before accepting it. Each dispatch reserves 2,816 tokens. The batch reserves up to twice that amount per input row, including failed and interrupted attempts. Local compute time and energy remain internal costs.

```sh
MODEL_MODE=ollama OLLAMA_MODEL=qwen3:4b-instruct npm run baseline -- fixtures/ten-products.json
```

This comparison uses the same inputs and local model in both runs. The direct arm generates once per valid row. Both arms score outputs with the same checks. The budget arm can repair each row once. The script records outcomes, attempts, tokens, and wall time. It never contacts PayPal.

## Connect PayPal Sandbox

For a clean-room test from your own Sandbox account, use the [judging guide](JUDGING.md). The [runtime notices](THIRD-PARTY-NOTICES.md) list separately installed components.

Use your own Sandbox Merchant app and a separate personal Sandbox buyer. The [PayPal developer guide](https://developer.paypal.com/sandbox-testing/accounts) explains both test account types. Open **Apps & Credentials → Sandbox** in the Developer Dashboard. Store the Merchant app credentials in your private local environment.

```sh
umask 077
cp .env.example .env
chmod 600 .env
```

Edit `.env` locally. Set `PAYMENT_MODE=paypal-sandbox`, `PAYPAL_SANDBOX_CLIENT_ID`, and `PAYPAL_SANDBOX_CLIENT_SECRET`. Set the model mode as described above. Run `npm start` and create a quote. Open the Sandbox buyer approval, sign in with your test buyer, and approve. Back in the workbench, choose **Verify approval and run**. A browser return alone cannot authorize or charge.

The seller checks the order, authorizes the approved amount, and confirms the authorization before model work. It computes the charge from accepted rows and requests an explicit amount with `final_capture=true`. A separate read checks the capture, currency, amount, and authorization status. With zero accepted rows, it voids the authorization and checks for `VOIDED` and no captures. PayPal determines the timing of any unused hold. The Sandbox adapter uses a fixed Sandbox API host. Keep local secrets, buyer logins, and runtime state private.

To test PayPal in isolation before running model work, use the two separate Sandbox orders below. Open the approval link from each `create` command as your test buyer before running its `finish` command.

```sh
npm run sandbox:gate -- create partial
npm run sandbox:gate -- finish partial
npm run sandbox:gate -- create void
npm run sandbox:gate -- finish void
```

The first probe authorizes $0.50 and requests a final $0.40 capture. The second authorizes $0.50 and voids the entire authorization. The CLI preserves the original orders and writes redacted evidence to `.runtime/gate/redacted-evidence.json`. A PayPal rejection reports the stage, HTTP status, issue codes, and debug ID when supplied. See [PayPal capture](https://developer.paypal.com/api/payments/v2/authorizations-capture/) and [void](https://developer.paypal.com/api/payments/v2/authorizations-void/).

## Read the receipt independently

Download the signed receipt and trusted public key separately. Open **Receipt verifier**, select the files, and choose **Verify and recompute**. Then choose **Test a changed line price** to see the signature check reject the edit. You can also run the same browser-independent checks from the command line.

```sh
npm run verify -- receipt.json trusted-key.txt
npm run verify -- receipt.json trusted-key.txt --tamper
```

The verifier reads no checkout state and makes no PayPal requests. It checks an Ed25519 signature against the separately trusted key, hashes the batch input and accepted output, recomputes line totals, and reconciles them to the signed payment observations. The issuer is responsible for the original PayPal readback. The receipt may include the uploaded product data. Share it only with the intended recipient.

## Recovery and scope

- The quote freezes the input digest, unit rate, maximum charge, model, payment mode, test settings, and expiry. A single writer persists each payment operation before it can reach PayPal. Concurrent actions on one batch are rejected. The server listens on loopback and accepts same-origin mutations.
- After a timeout, use **Recover original payment** or repeat the same gate command. SafeRouter reads the existing order, authorization and any known capture before a retry. If no capture is visible and the authorization is still open, it can replay the original request ID once within five minutes. A known pending capture is only read. Cancellation cannot race a dispatched capture. For an unresolved outcome beyond the replay window, reconcile the original order with the merchant before taking further action.
- Keep `.runtime/` across restarts. It stores the journal and the receipt signing key. If a process exits abruptly and leaves `writer.lock`, confirm the writer has stopped before removing that empty lock directory. Restart with the frozen payment and model configuration. Starting the server alone performs no payment writes.
- The policy checks exact structured facts, source field references, duplicates, selected prohibited phrases, unsupported numeric prose, and required title terms where supplied. Human review still covers translation accuracy, naturalness, qualitative claims and legal compliance. The sandbox demo price does not include a production pricing analysis.
