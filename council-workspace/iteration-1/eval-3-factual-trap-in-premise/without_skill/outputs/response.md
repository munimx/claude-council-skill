**The multi-model council didn't run.** The council skill needs the Workflow tool, and this session doesn't have it. What follows is my answer alone, from one model, and it is not a council verdict. I checked the key claims against the Python docs and a benchmark I ran on this machine, but nothing else reviewed it. For the multi-model version, run `/council` in a session that has the Workflow tool.

## Verdict: your premise is wrong, but the switch may still work for a different reason

**1. The GIL isn't gone in Python 3.13.** The standard build still has it; this machine's 3.13.3 reports `sys._is_gil_enabled() == True`. The 3.13 docs call free-threading an experimental, separate build (`python3.13t`). It runs about 40% slower on single-threaded code in 3.13, and if you import a C extension that isn't marked safe for it, the GIL comes back on with only a warning. Unless you deliberately installed 3.13t, your threads run under the GIL. To check, run `python -c "import sys; print(sys._is_gil_enabled())"` inside your workers after all imports.

**2. Threads can still work, because your imaging library may release the GIL.** Pillow releases the GIL while it decodes, resizes and encodes in C. I resized 48 jobs of 12 MP JPEGs with LANCZOS on the normal GIL build, Pillow 11.3, 8 workers:

| setup | time | peak memory (all processes) |
|---|---|---|
| serial | 8.3 s | 133 MiB |
| ThreadPoolExecutor(8) | 1.76 s | 882 MiB |
| spawn Pool(8) | 1.76 s | 1106 MiB |
| threads + `Image.draft()` | 1.16 s | 279 MiB |
| Pool + `Image.draft()` | 1.05 s | 507 MiB |

Threads matched processes with the GIL still on. This only holds if the heavy work happens inside the library. Pure-Python pixel loops won't speed up under threads, and you haven't said which library you use.

**3. Switching to threads saves less memory than you'd expect.** Threads saved about 20%, roughly 28 MiB per worker. Most of the memory is decoded pixel buffers (about 36 MB per 12 MP image in flight), and threads need those too. The bigger savings come from decoding at reduced size: `Image.draft()` or `thumbnail()` cut the threaded peak from 882 to 279 MiB and was faster too. Also limit how many images are in flight at once.

**4. What you give up by leaving processes:**
- **Crash isolation.** A segfault in a C decoder on a malformed image takes down the whole service, not just one worker.
- **Timeouts.** You can't kill a hung thread.
- **Worker recycling.** You lose `maxtasksperchild`, which restarts workers to clear leaks and memory fragmentation. A long-running threaded process may never give that memory back.
- **Worker count.** The default `max_workers` for ThreadPoolExecutor is CPU count + 4 (up to 32), which is too many for CPU-bound work. Set it to the core count.

**5. If you do move to free-threading,** the 3.14 docs put the slowdown at about 1–8%, down from about 40% in 3.13. Pillow still calls its free-threading support experimental (Pillow 11.0 release notes).

**What I'd do:** benchmark your real pipeline on the normal build first; that may be all you need. Add `draft()` or `thumbnail()` for the real memory win. If your inputs are untrusted, keep a process boundary, for example a small pool of processes that each run threads.

**Limits of the benchmark:** it used synthetic images on macOS arm64 with the spawn start method. On Linux with fork, pages shared between processes are counted more than once in the memory totals, so the gap between threads and processes may be smaller there.

Files are in `/private/tmp/claude-501/-Users-munimahmad-Liftoff-claude-council-skill/4cf2eee3-eea8-49a6-865d-5f937822e308/scratchpad/gilbench/`:
- `bench.py`: the benchmark
- `mk.py`: generates the test images