**Council verdict: Partly.** Keep multiprocessing.Pool and tune it for memory after measuring where the memory goes; the plan to switch to threads rests on a false premise, because Python 3.13's default build still has the GIL.
Confidence: **low**. Confidence is capped at low. The facts that decide between the options are unknown: the production imaging library, the Python build, and where the memory actually goes. All throughput figures come from scratch runs on loaded machines, not from the asker's system.

**What you asked:** Whether replacing a multiprocessing.Pool of CPU-bound image-resizing workers with a ThreadPoolExecutor is sound on Python 3.13, on the premise that the removal of the GIL makes threading suitable for CPU-bound work, and… → **what you're after:** Reduce the resizing workers' memory footprint without losing throughput or reliability.

### Answer
Keep the process pool and tune it. That is the right first move. Python 3.13 did not remove the GIL. The standard build still has it, and free-threading is a separate, experimental python3.13t executable.

1. Check the build in production: run `python -VV` and `import sys; sys._is_gil_enabled()`. Do not switch to 3.13t/3.14t just for this. It is slower on a single thread, and importing any C extension that is not marked free-threading-safe turns the GIL back on.
2. Measure per-worker memory with PSS, not RSS: `smem -P python` or `/proc/<pid>/smaps_rollup`. Compare the per-process baseline (interpreter plus imports, roughly 20-80 MB each in the council's scratch runs) against the size of the decoded images.
3. Tune the pool:
 - Set workers to at most the number of physical cores.
 - Set the start method explicitly rather than relying on the default: fork, or forkserver with `set_forkserver_preload` and modules imported before workers start. Call `gc.freeze()` before forking so the shared baseline stays shared.
 - Set `maxtasksperchild` to about 50-200 to recycle workers that leak or fragment memory.
 - On glibc, set `MALLOC_ARENA_MAX=2`.
4. If decoded image buffers dominate, fewer processes will not help much. Limit the number of images in flight with a semaphore or bounded queue, set `Image.MAX_IMAGE_PIXELS`, and decode JPEGs smaller using `Image.draft()`, `reduce()` or `thumbnail(reducing_gap=...)`.
5. If the baseline dominates, benchmark the hybrid against the tuned pool: 2-3 processes, each with a thread pool (for example 2 x 4 on 8 cores). Use production images and the production library, and test 1, 2, 4 and 8 threads per process. Adopt the hybrid only if throughput stays within about 10-15% of the tuned pool and peak PSS falls. It works only if the library releases the GIL while it works. The council read Pillow 11.3's source and found that it does this around every resample loop and during JPEG decode. In a scratch benchmark the council ran (3.13.3 standard build, Pillow 11.3, 8 cores), 8 threads matched a fork pool: 5.0-6.9 vs 5.7-6.6 images/s. The thread version used about 277 MB in one process; the pool used a 75 MB parent plus eight children of about 61 MB RSS each. These numbers are indicative only, not a measurement of your system.
6. A single ThreadPoolExecutor process is the last option. Consider it only if the benchmark passes and you replace the isolation you lose:
 - a process supervisor
 - per-job timeouts
 - a pixel cap
 - a memory watchdog that restarts the process, because there is no maxtasksperchild

### Why
- The premise that Python 3.13 removed the GIL is false for the default build, so the switch to threads cannot be justified on that basis.
- Threads save only the duplicated per-process interpreter and import memory. Decoded image buffers cost the same under threads or processes, so whether any switch pays off depends on a measurement nobody has made yet.
- Moving everything into one process removes crash isolation and the maxtasksperchild leak bound. Tuning the pool keeps both, and the hybrid keeps most of both.
- Tuning the pool needs none of the missing facts (build, library, GIL behavior), so it is the one step that is safe to take now. It also produces the baseline any thread-based option has to beat.

### Options weighed
1. ❌ Keep multiprocessing.Pool unchanged: unsound. Safe, but it does nothing toward the stated goal of reducing worker memory.
2. ✅ Hybrid: fewer worker processes, each running a thread pool: sound with changes. The best next step if measurement shows the memory is mostly the per-process interpreter and import baseline. It keeps most of the thread savings and still keeps crash isolation and maxtasksperchild.
3. ◐ Replace multiprocessing.Pool with ThreadPoolExecutor: partly sound. The stated reason is wrong because the default 3.13 build still has the GIL. It can still work on the standard build if the imaging library releases the GIL.
4. ✅ Keep multiprocessing.Pool and tune it to reduce memory (worker count, maxtasksperchild, start method, shared memory): **recommended**

### Your premises, checked
| Claim | Verdict | Basis |
|---|---|---|
| The GIL is removed in Python 3.13 (in the default CPython build). | ❌ does not hold | Accurate version: Python 3.13 introduces an experimental free-threaded (no-GIL) build option, but it is not the default CPython build — the default build still runs with the GIL enabled. The free-threaded build is a separate, optional binary (e.g. |
| On Python 3.13, threads in a ThreadPoolExecutor run CPU-bound work in parallel across cores, so throughput is comparable to a multiprocessing.Pool. | ❌ does not hold | Accurate version: On the default (standard, GIL-enabled) build of Python 3.13, threads in a ThreadPoolExecutor do NOT run CPU-bound Python bytecode in parallel across cores; |
| Replacing multiprocessing.Pool with ThreadPoolExecutor will materially reduce the memory used by the image-resizing workers. | ◐ partly | the analysts' assessment, not tool-verified |
| The image-resizing workload is CPU-bound in a way that the GIL limits, so parallelism for it depends on whether the GIL is present. | ◐ partly | the analysts' assessment, not tool-verified |

### Do these first
- **do first**: Measure per-worker PSS against decoded-image size before changing anything. The right fix is different when image buffers, rather than the per-process baseline, take up the memory.
- **do first** (verified): Confirm the production build with python -VV and sys._is_gil_enabled(). If it turns out to be free-threaded, check that the GIL stays disabled after every C extension has been imported.
- **do alongside**: Any move to threads, hybrid or full, must first pass a threads-versus-tuned-pool benchmark on the production library and real images. If thread throughput is below about 85-90% of the pool's, the library is holding the GIL and threads are the wrong tool.
- **do alongside** (verified): Collapsing to one process means a segfault or OOM on one bad image takes down every worker, and there is no maxtasksperchild to bound leaks. Keep the pool's recycling, or replace it with a supervisor, per-job timeouts, a pixel cap and a memory watchdog.
- **do alongside** (verified): Limit the number of images in flight and set Image.MAX_IMAGE_PIXELS. Peak memory from buffers grows with concurrency, whatever the process or thread model.
- **minor**: Set the start method explicitly. Recalled, not independently checked: the POSIX default changes to forkserver in 3.14, which would lose fork's copy-on-write sharing after an upgrade.

### Corrections to the premises
- Python 3.13's default CPython build still has the GIL. Free-threading is an experimental, opt-in build (python3.13t). In 3.14 it becomes officially supported but is still optional, not the default.
- On the standard 3.13 build, threads do not run CPU-bound Python code in parallel. They run in parallel only while native code releases the GIL. Pillow does this during resize and JPEG decode, so throughput can match a process pool, but only for that part of the work and only for libraries that release the GIL.
- Threads save roughly (N-1) times the per-process interpreter and import baseline. They do not shrink decoded image buffers, which grow with the number of images in flight. With fork and copy-on-write, part of that baseline is already shared, so the real saving may be smaller than RSS figures suggest.
- Whether the GIL limits the workload depends on the imaging library, not on the Python version. Libraries that release the GIL in their resize loops, as Pillow does, can run in parallel under threads even with the GIL present. Python-level glue code around the resize is still serialized.

### Where you and the council disagree
You said: "since the GIL is gone in Python 3.13, threading is now fine for CPU-bound work, so I'm going to replace our multiprocessing.Pool image-resizing workers with a ThreadPoolExecutor to cut memory usage"
The council recommends: Keep multiprocessing.Pool and tune it to reduce memory (worker count, maxtasksperchild, start method, shared memory).
What the council may be missing: We know nothing about how the service fails today: how often OOM kills or segfaults happen, or whether maxtasksperchild is already set to contain a known leak. We also don't know how much Python-level work surrounds each resize (I/O, metadata, format conversion), and that work stays serialized under the GIL whatever the pool model.
Cost if the council is wrong: Tuning the pool first costs a short round of measuring and config changes. If the memory really is duplicated baseline that copy-on-write cannot share, the service carries more memory than it needs for one extra iteration before the hybrid is adopted. That is a delay, not a failure. Switching straight to a single thread pool when that was wrong would be worse: whole-service crashes or a big drop in throughput.
Your call stays the default until you decide otherwise.

### Minority report
**option 3: Replace multiprocessing.Pool with ThreadPoolExecutor** (Claude Fable): I still recommend replacing the process pool with a thread pool, provided one cheap benchmark passes first. The majority is treating "the GIL is still on in 3.13" as the end of the argument. It is not. The GIL only matters if the resize code holds it, and mainstream imaging libraries do not: Pillow 11.3 wraps every resampling loop and the JPEG decoder in GIL-release sections, and my measurement on the standard 3.13.3 build (8 cores, 48 large JPEGs decoded and LANCZOS-resized) showed a ThreadPoolExecutor at 5.0-6.9 images/sec versus a fork Pool at 5.7-6.6, i.e. the same throughput, with roughly half the total resident memory (277 MB in one process versus 75 MB parent plus eight ~61 MB children). Tuning the pool cannot get that saving: every worker process still pays the interpreter and import baseline again, and maxtasksperchild only bounds leaks, it does not remove duplication. The real costs of threads are the ones I listed, and they are operational, not performance: one bad image can crash all workers, so you need a supervisor, Image.MAX_IMAGE_PIXELS, a per-job timeout and a memory watchdog. Those are a day of work, not a reason to leave half the memory on the table. If fault isolation is a hard requirement, the hybrid (two or three processes each running threads) keeps most of the saving. I would concede to "keep and tune the pool" under exactly one condition: run the thread-versus-pool benchmark on the production interpreter and imaging library, and if thread throughput comes in below about 85% of the pool's, the library is holding the GIL and threads are the wrong tool.
Not adopted because: The production imaging library and build are unknown, so the thread benchmark has not run on the real stack. The saving was measured as RSS, which overcounts memory that fork shares copy-on-write. A full thread pool gives up crash isolation and leak recycling, which was verified. Tuning the pool first costs little and produces the baseline any thread option has to beat.
It would be right if: Keeping and tuning the pool is right if, on the production interpreter and imaging library, a ThreadPoolExecutor delivers less than about 85% of the existing pool's resize throughput (meaning the resize path holds the GIL for most of its wall time), or if per-job crash isolation is a hard requirement that a supervisor plus size caps and timeouts cannot satisfy.

### Where this could be wrong
- If PSS shows that copy-on-write barely shares anything, for example because Python refcount writes dirty the shared pages, then tuning the pool will recover little, and the hybrid or thread model may be the only way to a large saving.
- Every thread-scaling figure came from scratch runs on heavily loaded machines (load averages of 40-50 on 8 cores). The real ratio of thread to process throughput could be better or worse.
- The service may not use Pillow at all. The findings about releasing the GIL were checked only for Pillow 11.3.
- **What would change the verdict:** A PSS breakdown showing that per-process baseline memory, not shared by copy-on-write, dominates worker memory, together with a production benchmark where threads reach at least 90% of the tuned pool's throughput. That would favor the hybrid or a full thread pool.; Confirmation that production runs a free-threaded build with sys._is_gil_enabled() returning False after all imports, and that every extension in the path supports free-threading.; A benchmark showing thread throughput below about 85% of the pool's on the production library. That would rule out both thread options and leave pool tuning as the only path.

_Council: 4 blind seats (Fable, Opus, Sonnet, Opus) · blind vote 1–1–1 · 5 claim(s) settled with tools. All voting seats were Claude models, so their agreement is one model family's view._
