import { Sidebar } from './components/Sidebar';
import { TabBar } from './components/TabBar';
import { DragDropProvider } from './components/DragDropProvider';
import { TitleBar } from './components/TitleBar';
import { TerminalPaneContainer } from './components/TerminalPaneContainer';
import { StatusBar } from './components/StatusBar';
import { useFileDropToTerminal } from './hooks/useFileDropToTerminal';
import { FileDropOverlay } from './components/FileDropOverlay';
import './styles/variables.css';
import './styles/title-bar.css';
import './styles/dropdown-menu.css';
import './styles/update-dialog.css';
import './styles/status-bar.css';

/**
 * 画面の構成。
 *
 * 副作用はすべて機能ごとの Root (`src/Roots.tsx` 参照) が持つので、ここには
 * 「何をどこに置くか」しか残っていない。
 */
function App() {
  const { isDragging } = useFileDropToTerminal();

  return (
    <div className="app-root">
      <TitleBar />
      <div className="app-body">
        {/* D&D は Sidebar と TabBar をまたぐため、両方を包む位置に DndContext を置く
            (TabBar のタブをサイドバーのグループ行へドロップして移動できるようにする) */}
        <DragDropProvider>
          <Sidebar />
          <div className="main-column">
            <TabBar />
            <TerminalPaneContainer />
          </div>
        </DragDropProvider>
        <FileDropOverlay isDragging={isDragging} />
      </div>
      {/* サイドバーの下まで通す全幅の 1 行。出すものが無いときは自身で消える */}
      <StatusBar />
    </div>
  );
}

export default App;
