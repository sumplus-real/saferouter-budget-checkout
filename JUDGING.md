# Run SafeRouter with your own PayPal Sandbox

You can run the workbench on your computer with a free PayPal Sandbox and a local model. Use Node.js 20.19 or newer, npm, and a current browser with Ed25519 Web Crypto support. The checkout has no npm packages to install.

## Create the test environment

1. Open the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/) with your own PayPal account. Under [Sandbox Accounts](https://developer.paypal.com/dashboard/accounts), locate the **Business** test account for the seller and the separate **Personal** test account for the buyer. PayPal normally provides both on first dashboard login. If needed, create them under the corresponding account types. [Sandbox account guide](https://developer.paypal.com/sandbox-testing/accounts)
2. Under [Sandbox Apps & Credentials](https://developer.paypal.com/dashboard/applications/sandbox), select an existing Sandbox Merchant app for that Business account, or create a dedicated Sandbox app against it. Use the app's Sandbox Client ID and Client Secret. The merchant app makes server API calls. You will sign in to the hosted Sandbox checkout as the Personal test buyer. [PayPal REST setup](https://developer.paypal.com/api/rest/)
3. In the source directory, create the private configuration file once.

   ```sh
   (umask 077; test -e .env || cp .env.example .env)
   chmod 600 .env
   ```

   Open `.env` in a local editor. If the two Sandbox variables are already exported in your shell, unset them in the terminal that will run the app so the file supplies the intended values. Set `PAYPAL_SANDBOX_CLIENT_ID` and `PAYPAL_SANDBOX_CLIENT_SECRET` there. Keep the file on your machine and keep it out of version control. Enter the Personal test buyer's login only on PayPal's Sandbox page. Use test accounts and the Sandbox tab throughout.

## Probe payment before adding the model

Run `npm test` from the source directory. For a local return page at port 4188, start `PAYMENT_MODE=fixture MODEL_MODE=fixture PORT=4188 npm start` in one terminal. Run the following from a second terminal in the same source directory. The gate uses the real PayPal Sandbox independently of the workbench's payment mode.

1. Run `npm run sandbox:gate -- create partial`. Open the approval URL shown in your terminal, sign in as the Personal test buyer and approve $0.50 USD. After approval run `npm run sandbox:gate -- finish partial`. Look for `authorizedCents: 50` and a final capture with `cents: 40` and `captureStatus: COMPLETED`. Record the observed authorization status.
2. Run `npm run sandbox:gate -- create void`. Approve this second order as the test buyer. Run `npm run sandbox:gate -- finish void`. Look for `authorizationStatus: VOIDED`, a zero-cent outcome, and no capture ID.
3. The CLI writes a redacted record of both probes to `.runtime/gate/redacted-evidence.json`. Keep the approval URL and raw runtime journal private. If a response is lost, keep the journal and the same Sandbox Merchant app, then repeat the original command for that scenario. If the outcome stays unresolved, reconcile that order before proceeding.

## Run the workbench with AI and Sandbox together

Install [Ollama](https://docs.ollama.com/) and start a local server. For a CLI-managed server, run `OLLAMA_NO_CLOUD=1 ollama serve` in its own terminal. If the desktop app already runs the local server, use that server. In another terminal run `ollama pull qwen3:4b-instruct`. The model download is about 2.5 GB. [Model and license](https://ollama.com/library/qwen3:4b-instruct)

Stop the fixture workbench, then set `PAYMENT_MODE=paypal-sandbox`, `MODEL_MODE=ollama`, and `OLLAMA_MODEL=qwen3:4b-instruct` in `.env`. The default Ollama port is 11434. Set `OLLAMA_PORT` if yours differs. Start the app with `npm start` and open [the local workbench](http://127.0.0.1:4188/). Check for **PAYMENT · PAYPAL SANDBOX** and the local model label.

1. Load the ten-product sample. Select **Add labeled test faults to model output** before freezing the quote if you want to exercise repair and rejection. Create an approval, approve in PayPal Sandbox as the test buyer, and choose **Verify approval and run**.
2. Check that the final captured amount is five cents times the actual accepted count, at most $0.50. The accepted count depends on the generated outputs. Open individual rows to see the validation decisions. The PayPal authorization state reflects the API readback. The app does not infer when an unused hold becomes available.
3. Download the signed receipt and verifier key separately. Open **Receipt verifier**, select the files and choose **Verify and recompute**. Choose **Test a changed line price** and expect rejection. To verify independently on the command line, run `npm run verify -- RECEIPT.json TRUSTED_KEY.txt`.
4. Start a separate batch from `fixtures/all-rejected.json`. Approve its quote and run the batch. Expect a voided authorization, a zero-cent charge, and no capture. The standalone gate's void probe uses a fixed $0.50. This three-row workbench fixture has a $0.15 quote.

For a quick local preview without a PayPal login, run `PAYMENT_MODE=fixture npm start`. The fixture label identifies simulated payment. With `MODEL_MODE=fixture` the generation is simulated too.
