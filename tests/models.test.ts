import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ModelInfo } from "@qoder-ai/qoder-agent-sdk";
import { resolveModelFromList, resolveContextWindow } from "../src/daemon.js";

const MOCK_MODELS: ModelInfo[] = [
  { value: "auto", displayName: "Auto", description: "", modelId: "auto", availableContextWindows: [200000, 400000, 1000000] },
  { value: "ultimate", displayName: "Ultimate", description: "", modelId: "ultimate", availableContextWindows: [200000, 400000, 1000000] },
  { value: "fast", displayName: "Fast", description: "", modelId: "fast", availableContextWindows: [200000, 400000, 1000000] },
  { value: "efficient", displayName: "Efficient", description: "", modelId: "efficient", availableContextWindows: [200000] },
  { value: "qmodel_latest", displayName: "Qwen4-Max", description: "", modelId: "qmodel_latest", availableContextWindows: [200000, 400000, 1000000] },
  { value: "qmodel_38max", displayName: "Qwen3.8-Max", description: "", modelId: "qmodel_38max" },
  { value: "qfmodel", displayName: "Qwen3.8-Flash", description: "", modelId: "qfmodel" },
  { value: "gmodel_latest", displayName: "GLM-5.4", description: "", modelId: "gmodel_latest" },
];

describe("resolveModelFromList", () => {
  it("resolves exact displayName case-insensitively to SDK value", () => {
    assert.equal(resolveModelFromList(MOCK_MODELS, "Qwen4-Max"), "qmodel_latest");
    assert.equal(resolveModelFromList(MOCK_MODELS, "qwen3.8-max"), "qmodel_38max");
    assert.equal(resolveModelFromList(MOCK_MODELS, "GLM-5.4"), "gmodel_latest");
  });

  it("resolves exact value directly", () => {
    assert.equal(resolveModelFromList(MOCK_MODELS, "qmodel_latest"), "qmodel_latest");
  });

  it("resolves Claude/OpenAI/family aliases dynamically", () => {
    assert.equal(resolveModelFromList(MOCK_MODELS, "claude-3-opus"), "ultimate");
    assert.equal(resolveModelFromList(MOCK_MODELS, "claude-3.5-haiku"), "fast");
    assert.equal(resolveModelFromList(MOCK_MODELS, "qwen"), "qmodel_latest");
    assert.equal(resolveModelFromList(MOCK_MODELS, "unknown-model-xyz"), "auto");
  });

  it("picks largest supported context window up to target", () => {
    assert.equal(resolveContextWindow(MOCK_MODELS, "qmodel_latest", 1000000), 1000000);
    assert.equal(resolveContextWindow(MOCK_MODELS, "efficient", 1000000), 200000);
    assert.equal(resolveContextWindow(MOCK_MODELS, "qmodel_38max", 1000000), undefined);
  });
});
