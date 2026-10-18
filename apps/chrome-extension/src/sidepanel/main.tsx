import '../styles.css';
import { createBrowserPdfEngine } from '@folio/pdf-core/browser';
import { mountSurface } from '../shared/surface';
import { SidePanel } from './side-panel';

const engine = createBrowserPdfEngine();

mountSurface(() => <SidePanel engine={engine} />);
