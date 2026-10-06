export const A = ({ go }: { go: () => void }) => (
  <div role="button" tabIndex={0} onClick={go} onKeyDown={go}>
    Open
  </div>
);
