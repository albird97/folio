import type { DialogOf } from '../../store/ui';
import { NotReady } from './not-ready';

export function ExportTextDialog({ request }: { request: DialogOf<'export-text'> }) {
  void request;
  return <NotReady title="Export text" />;
}
