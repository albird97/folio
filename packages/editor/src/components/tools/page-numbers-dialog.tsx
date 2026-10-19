import type { DialogOf } from '../../store/ui';
import { NotReady } from './not-ready';

export function PageNumbersDialog({ request }: { request: DialogOf<'page-numbers'> }) {
  void request;
  return <NotReady title="Page numbers" />;
}
