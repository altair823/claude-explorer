# session-explorer

Claude Code 오른쪽 패널에 파일 트리를 보여 주는 mod입니다. 트리 안에 각 폴더에서 실행 중인 Claude Code, Codex 세션과 끝난 대화를 함께 표시합니다. zellij나 tmux 탭 여러 개에 세션이 흩어져 있을 때 어느 폴더에 어떤 세션이 있는지 찾고, 패널에서 바로 그 세션의 창으로 이동할 수 있습니다.

## 설치

```
claude plugin marketplace add altair823/claude-session-explorer
claude plugin install session-explorer@claude-session-explorer
```

`/session-explorer`로 패널을 엽니다. 직접 닫지 않으면 다음 세션에도 열립니다. git-graph, pr-board 같은 다른 패널과 함께 쓰면 패널 위쪽의 탭을 눌러 바꿉니다.

창 이동과 새 탭 열기는 이 Claude Code가 zellij나 tmux 안에서 실행 중일 때만 동작합니다. 밖에서 실행하면 실행할 명령을 알림으로 보여 줍니다.

## 화면

```
 ~/projects                    트리 밖 세션 1
 ..
 ▾ claude-pr-board/        M3  ●1
     ● projects-3b        작업 중
     ○ git-graph 만들기   대기
     · 0.1.6 GitHub 지원  11-17
     … 끝난 대화 12개 더 보기
 ▸ my-app/                     ●1
   README.md               M
──────────────────────────────────
 h 위로  l 펼치기  s 세션  t 셸  c Claude  x Codex  a 숨김
```

| 표시 | 뜻 |
|---|---|
| `M3` | 폴더 안에서 바뀐 파일 수(git 기준) |
| `M` `A` `D` `R` `?` | 파일의 git 상태. 수정, 추가, 삭제, 이름 변경, 추적하지 않는 새 파일입니다 |
| `●1` | 폴더와 그 아래에서 실행 중인 세션 수 |
| `●` `○` `◆` | 실행 중인 Claude 세션(작업 중, 대기)과 Codex 세션 |
| `·` | 끝난 대화. 폴더마다 최근 5개를 보여 주고, 더 보기 줄을 누르면 전부 보여 줍니다 |
| `이 세션` | 지금 패널을 보고 있는 Claude 세션 |
| `트리 밖 세션 N` | 지금 트리에 보이지 않는 폴더에서 실행 중인 세션 수. `s`로 찾아갑니다 |

## 조작

`ctrl+x tab`으로 패널에 들어온 뒤 방향키로 줄을 옮깁니다. 마우스로 줄을 누르면 선택되고, 선택한 줄을 다시 누르면 엽니다.

| 키 | 하는 일 |
|---|---|
| Enter | 폴더면 그 폴더로 들어갑니다. 파일이면 입력창에 `@경로`를 넣습니다. 실행 중인 세션이면 그 창으로 이동합니다. 끝난 대화면 새 탭에서 이어서 시작합니다 |
| `h` | 상위 폴더로 올라갑니다 |
| `l` | 폴더를 펼치거나 접습니다 |
| `s` | 실행 중인 세션을 차례로 찾아가 커서를 그 줄에 둡니다 |
| `t` `c` `x` | 커서가 있는 폴더에서 새 탭을 열고 셸, Claude, Codex를 시작합니다 |
| `a` | `.`으로 시작하는 파일을 보이거나 감춥니다 |

패널 버튼은 Backspace와 더블클릭을 받을 수 없어서 `h`와 "선택한 줄 다시 누르기"로 대신합니다.

## 조회 방식

패널이 보일 때만 조회합니다. 실행 중인 세션과 git 상태는 3초마다, 끝난 대화는 30초마다 읽습니다. 모두 이 컴퓨터 안에서만 읽고 원격 서버에 요청하지 않습니다.

- 실행 중인 Claude 세션: `~/.claude/sessions/<pid>.json`과 `/proc`. 프로세스 시작 시각까지 비교해 끝난 세션의 기록을 걸러 냅니다.
- 실행 중인 Codex 세션: `/proc`에서 터미널에 연결된 `codex` 프로세스.
- 끝난 대화: `~/.claude/projects/`와 `~/.codex/sessions/`.
- 창 위치: 세션 프로세스의 `ZELLIJ_SESSION_NAME`, `ZELLIJ_PANE_ID`, `TMUX`, `TMUX_PANE` 환경 변수.

## 이슈와 PR

버그나 제안은 이슈로 올리면 됩니다.

이 저장소는 비공개 저장소를 그대로 옮겨 오는 미러라서, 여기서 PR을 머지하면 다음 동기화 때 지워집니다. 그래서 PR 내용은 비공개 저장소에 옮겨 반영하고, PR 작성자를 커밋의 공동 작성자로 남긴 뒤 PR을 닫습니다.

## 개발

```
claude plugin test .
claude plugin validate .
tsc -p .
```

main에 push하면 CI가 시험을 돌리고, 통과하면 다음 버전을 release 브랜치에 올리고 태그와 릴리스를 만듭니다. 설치본은 release 브랜치만 받습니다.

## 라이선스

MIT
