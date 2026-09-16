/**
 * ステートマシンの実行環境。Mediator はこの上に載る。
 *
 * 遷移関数は**純粋**に保つ。「今の状態 + 来たイベント」から「次の状態 + 実行したい副作用」
 * を返すだけで、非同期処理も I/O もしない。実際に副作用を回すのは `run` の役目で、
 * その結果はイベントとしてマシンへ戻ってくる。
 *
 * こうしておくと、遷移の全パターンを非同期抜きの素のテストで踏める。
 * 「ダウンロード中に適用ボタンが押されたらどうなるか」のような組み合わせは、
 * 実際に通信させなくても確かめられる。
 *
 * 遷移関数が `null` を返したら「そのイベントはこの状態では意味を持たない」という意思表示で、
 * 状態は変えず購読者にも通知しない。無効な操作を弾くのはここに一本化する。
 */

/** 遷移の結果。次の状態と、実行してほしい副作用。 */
export interface Step<S, Eff> {
  readonly state: S;
  readonly effects?: readonly Eff[];
}

/**
 * 遷移関数。`null` は「この状態ではこのイベントを扱わない」を意味する。
 */
export type TransitionFn<S, E, Eff> = (state: S, event: E) => Step<S, Eff> | null;

export interface Machine<S, E> {
  getState(): S;
  send(event: E): void;
  subscribe(listener: () => void): () => void;
}

export interface MachineOptions<S, E, Eff> {
  readonly initial: S;
  readonly transition: TransitionFn<S, E, Eff>;
  /**
   * 副作用の実行。結果は `send` でマシンへ返す。
   * 例外を投げないこと (投げても握り潰されるが、失敗はイベントで表現するべき)。
   */
  readonly run?: (effect: Eff, send: (event: E) => void) => void;
}

export function createMachine<S, E, Eff>({
  initial,
  transition,
  run,
}: MachineOptions<S, E, Eff>): Machine<S, E> {
  let state = initial;
  const listeners = new Set<() => void>();

  // 副作用が同期的に send を呼び返してくることがある (テストの偽装実装や、
  // 即座に失敗するケース)。遷移の途中で再入すると状態が入れ替わる順序が読めなく
  // なるので、キューに積んで 1 件ずつ捌く。
  const queue: E[] = [];
  let draining = false;

  /** 副作用からマシンへイベントを返す口。 */
  function feedback(event: E): void {
    queue.push(event);
    // 同期的に呼ばれたなら今の while ループが拾う (draining === true)。
    // 非同期に (Promise の解決後などに) 呼ばれたときはここで回し直す。
    if (!draining) drain();
  }

  /** 1 イベントぶんの遷移を適用する。 */
  function step(event: E): void {
    const result = transition(state, event);
    if (!result) return; // 無効な操作。状態も通知も動かさない。

    if (result.state !== state) {
      state = result.state;
      for (const listener of listeners) listener();
    }

    if (!result.effects || !run) return;
    for (const effect of result.effects) run(effect, feedback);
  }

  function drain(): void {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        // shift の戻りは queue.length > 0 を確認済みなので必ず存在する
        step(queue.shift() as E);
      }
    } finally {
      draining = false;
    }
  }

  return {
    getState: () => state,
    send(event) {
      queue.push(event);
      drain();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
