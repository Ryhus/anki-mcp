import type {
  DesignValidation,
  DesignValidationIssue,
} from "./shared-schemas.js";

export function combineValidations(
  validations: DesignValidation[],
): DesignValidation {
  return createDesignValidation(
    validations.flatMap(({ issues }) => issues),
  );
}

export function createDesignValidation(
  issues: DesignValidationIssue[],
): DesignValidation {
  const errorCount = issues.filter(
    ({ severity }) => severity === "error",
  ).length;
  const warningCount = issues.length - errorCount;

  return {
    valid: errorCount === 0,
    errorCount,
    warningCount,
    issues,
  };
}
