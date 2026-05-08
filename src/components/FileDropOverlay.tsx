import '../styles/file-drop-overlay.css';

interface FileDropOverlayProps {
  isDragging: boolean;
}

export function FileDropOverlay({ isDragging }: FileDropOverlayProps) {
  if (!isDragging) return null;
  return (
    <div className="file-drop-overlay" aria-hidden="true">
      <div className="file-drop-overlay__panel">
        <div className="file-drop-overlay__icon">📎</div>
        <div className="file-drop-overlay__message">
          ファイルをドロップしてパスを貼り付け
        </div>
      </div>
    </div>
  );
}
