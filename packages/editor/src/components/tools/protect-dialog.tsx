import type { DialogOf } from '../../store/ui';
import { NotReady } from './not-ready';

export function ProtectDialog({ request }: { request: DialogOf<'protect'> }) {
  void request;
  return <NotReady title="Password protection" />;
}
