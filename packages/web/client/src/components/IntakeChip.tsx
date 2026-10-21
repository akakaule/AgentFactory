import type { Task } from '../types.js';

export function IntakeChip({ task }: { task: Task }) {
  if (task.intake?.state !== 'current' || task.intake.policy?.eligibility !== 'attention_required') return null;
  const reasons = task.intake.policy.reasons.map((r) => r.message).join('; ');
  return <span className="af-intake-chip" title={reasons}>Intake flags</span>;
}
