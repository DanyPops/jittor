import { decodeFauxScript, SCRIPT_ENV_VAR } from "@danypops/pi-process-harness";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Remove once pi-process-harness's payload-aware faux fixture release is consumed here. */
export default function (pi: ExtensionAPI): void {
	const encoded = process.env[SCRIPT_ENV_VAR];
	if (!encoded) throw new Error(`${SCRIPT_ENV_VAR} is required`);
	const script = decodeFauxScript(encoded);
	const handle = fauxProvider({ provider: "faux-payload" });
	pi.registerProvider(handle.provider);
	handle.setResponses(
		script.map((step) => async (context, options, _state, model) => {
			// faux has no wire serializer and currently skips onPayload. Its response factory is still
			// inside the real provider stream, so this drives Pi's actual before_provider_request chain
			// with a deterministic provider-neutral final payload before releasing the scripted response.
			await options?.onPayload?.({ system: context.systemPrompt, messages: context.messages, tools: context.tools ?? [] }, model);
			return step.type === "text"
				? fauxAssistantMessage(fauxText(step.text))
				: fauxAssistantMessage(fauxToolCall(step.name, step.arguments));
		}),
	);
}
