import type { DialogOf } from '../../store/ui';
import { NotReady } from './not-ready';

export function RecognizeTextDialog({ request }: { request: DialogOf<'recognize-text'> }) {
  void request;
  return <NotReady title="Recognize text" />;
}
