import type { DialogOf } from '../../store/ui';
import { NotReady } from './not-ready';

export function ReduceFileSizeDialog({ request }: { request: DialogOf<'reduce-file-size'> }) {
  void request;
  return <NotReady title="Reduce file size" />;
}
