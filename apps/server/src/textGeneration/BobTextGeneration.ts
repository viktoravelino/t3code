import * as Effect from "effect/Effect";

import { TextGenerationError } from "@t3tools/contracts";
import * as TextGeneration from "./TextGeneration.ts";

const unsupported = (operation: string) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: "BOB text generation helpers are not implemented yet.",
    }),
  );

export const makeBobTextGeneration = Effect.fn("makeBobTextGeneration")(function* () {
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
  } satisfies TextGeneration.TextGeneration["Service"];
});
