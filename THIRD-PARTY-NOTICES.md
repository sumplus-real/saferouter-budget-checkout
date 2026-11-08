# Runtime components and notices

The source package contains application code, documentation and synthetic product examples. It declares no npm packages. It uses Node.js built-in modules and browser APIs. No runtime binary, model weights, SDK, external font, or third-party media is distributed with the source.

| Component | Use | Distribution and terms |
| --- | --- | --- |
| Node.js | Runs the local service and test scripts | Installed separately. Node.js uses MIT terms for its own code and includes separate component notices. [Node.js license and notices](https://github.com/nodejs/node/blob/v20.19.6/LICENSE) |
| Ollama | Runs the model locally over HTTP | Installed separately. Ollama source is MIT. Its release distributions carry their own component notices. [Ollama license](https://github.com/ollama/ollama/blob/v0.40.15/LICENSE) |
| Qwen3-4B-Instruct-2507 | Local language model, pulled as `qwen3:4b-instruct` | Downloaded separately under Apache-2.0. [Model license](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507/blob/main/LICENSE), [Ollama model and license](https://ollama.com/library/qwen3:4b-instruct) |
| PayPal Sandbox | Orders v2 and Payments v2 through HTTPS | External service accessed with the tester's Sandbox account and credentials. The app includes no PayPal SDK or service credentials. [PayPal developer setup](https://developer.paypal.com/api/rest/) |

The optional LM Studio adapter calls a user-installed local HTTP service. LM Studio and its models are obtained separately under their respective terms. The reference judging setup uses Ollama.
