import type { DialogOf } from '../../store/ui';
import { NotReady } from './not-ready';

export function AskAiDialog({ request }: { request: DialogOf<'ask-ai'> }) {
  void request;
  return <NotReady title="Ask Claude" />;
}
