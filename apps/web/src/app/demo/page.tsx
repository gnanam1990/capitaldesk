import { PageIntro, PreviewGate } from '../../components/Console';
import { DemoWalkthrough } from '../../components/DemoWalkthrough';

export default function DemoPage() {
  return (
    <div className="cd-stack">
      <PageIntro
        eyebrow="Interactive product demo"
        title="Shared capital. Explicit decisions."
        summary="Explore how CapitalDesk coordinates conflicting agent targets, protects reserved capital, and explains partial fills. Every action below is a local simulation."
      />
      <PreviewGate>
        <DemoWalkthrough />
      </PreviewGate>
    </div>
  );
}
