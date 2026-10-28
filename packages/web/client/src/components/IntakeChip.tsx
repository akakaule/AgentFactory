import type { Task } from '../types.js';
import { queueBlockMessage } from '../queueGate.js';

export function IntakeChip({ task }: { task: Task }) {
  // intake pending hold: queued implementation work the dispatcher won't claim until the current
  // revision (e.g. a spec the description stage just wrote) is assessed, or the hold runs out
  if (task.intakeHold) {
    const until = new Date(task.intakeHold.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return <span className="af-intake-chip" title={`Held until ${until} while Task Intelligence assesses the written spec`}>Waiting for intake</span>;
  }
  const blocked = queueBlockMessage(task);
  if (blocked) return <span className="af-intake-chip" title={blocked}>Can't queue</span>;
  if (task.intake?.state !== 'current' || task.intake.policy?.eligibility !== 'attention_required') return null;
  const reasons = task.intake.policy.reasons.map((r) => r.message).join('; ');
  return <span className="af-intake-chip" title={reasons}>Intake flags</span>;
}
