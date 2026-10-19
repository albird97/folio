import type { DialogOf } from '../../store/ui';
import { NotReady } from './not-ready';

export function SignatureDialog({ request }: { request: DialogOf<'signature'> }) {
  void request;
  return <NotReady title="Add a signature" />;
}
