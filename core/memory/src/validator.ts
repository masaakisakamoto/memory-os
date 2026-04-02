/**
 * Validator — validates proposals against JSON schema and write policy.
 */

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import proposalSchema from '../../schemas/proposal.schema.json';
import writePolicy from '../../schemas/write-policy.json';

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validateProposal = ajv.compile(proposalSchema);

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  policy_allows: boolean;
  auto_approvable: boolean;
}

type WritePolicy = {
  propose: boolean;
  auto_approve: boolean | 'conditional';
  human_required: boolean;
};

export function validateProposalDoc(doc: unknown): ValidationResult {
  const errors: string[] = [];

  const schemaValid = validateProposal(doc);
  if (!schemaValid) {
    for (const err of validateProposal.errors || []) {
      errors.push(`${err.instancePath} ${err.message}`);
    }
  }

  const proposal = doc as { memory_type?: string; risk_level?: string };
  const memType = proposal.memory_type as string | undefined;
  const policy = memType ? (writePolicy as Record<string, WritePolicy>)[memType] : null;

  if (!policy) {
    errors.push(`Unknown memory_type: ${memType}`);
    return { valid: false, errors, policy_allows: false, auto_approvable: false };
  }

  if (!policy.propose) {
    errors.push(`memory_type ${memType} is not proposable`);
    return { valid: false, errors, policy_allows: false, auto_approvable: false };
  }

  const autoApprovable =
    policy.auto_approve === true &&
    !policy.human_required &&
    proposal.risk_level !== 'high';

  return {
    valid: schemaValid && errors.length === 0,
    errors,
    policy_allows: true,
    auto_approvable: autoApprovable,
  };
}
