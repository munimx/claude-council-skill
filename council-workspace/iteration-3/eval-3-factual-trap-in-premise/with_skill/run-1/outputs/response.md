**Council verdict: Yes, with changes.** Switch to a thread pool on the standard Python build, but only after a benchmark on production images confirms throughput holds. It works because the imaging library's C code releases the GIL, not because 3.13 removed it.
Confidence: **medium**. The premises were checked directly, and several independent benchmarks agree on direction. But nothing was run against the production job, library, images or Linux container, and the red team showed the size of the memory gain varies widely with the workload.

**What you asked:** Whether there is anything wrong with a plan to replace multiprocessing.Pool-based image-resizing workers with a ThreadPoolExecutor, on the premise that Python 3.13 has removed the GIL and that this makes threading suitable for CPU-bound work, done in order to cut memory usage. → **what you're after:** Reducing the memory footprint of a CPU-bound image-resizing worker pool while keeping the switch to a threaded execution model from breaking correctness or degrading throughput.

### Answer
The switch is sound, but the stated reason is wrong. Python 3.13 still has the GIL by default. Threads work here because Pillow's C decode, resample and encode code releases the GIL while it runs.

Steps, in order:
1. Check the interpreter: `python -VV` and `python -c "import sys,sysconfig;print(sys._is_gil_enabled(), sysconfig.get_config_var('Py_GIL_DISABLED'))"`. Stay on the standard build; do not move to python3.13t for this. Check which imaging library you use. Pillow releases the GIL in its hot path (confirmed in its source). OpenCV and pyvips probably do too, but this was not checked. An unknown or pure-Python library does not.
2. Benchmark the full production job function, not a bare resize, on real images. Compare ThreadPoolExecutor and the current Pool at 1, 2, 4 and 8 workers, recording wall time. Analyst runs with plain Pillow had threads beating Pool: 0.77s vs 1.07s, and 0.97s vs 1.72s. Once about 46ms of Python work was added per image, threads were about 47% slower than Pool. If more than roughly 30% of per-image time is Python code (metadata, numpy glue, custom loops), don't switch to threads alone.
3. Measure memory in the production container, using cgroup memory.current or PSS rather than summed RSS. Split it into interpreter baseline and decoded image buffers. Threads remove the duplicated interpreters (about 60–140MB per worker in the tests), not the image buffers. The 3x saving came from single-colour test images. With realistic 12MP photos the saving was about 37%.
4. If both checks pass, switch to `ThreadPoolExecutor(max_workers=os.cpu_count())`. Put a semaphore or bounded queue on submissions so only about as many images as there are cores are in flight. Use `Image.draft()` or `reduce=` to decode JPEGs at reduced size when downscaling. Keep the Pool code path behind a config flag so you can roll back.
5. Replace the worker recycling the Pool gave you. Set `MALLOC_ARENA_MAX=2`, or use jemalloc. Run a multi-day soak test watching RSS, and have the supervisor restart the process after N jobs or above an RSS limit.
6. Before porting, audit the worker code for per-process globals, temp names built from the process ID, `os.chdir`, and per-task changes to global Pillow settings.

If threads reach less throughput than you need, run 2–3 processes each with a thread pool. If the job is mostly Python work, keep processes and trim them: fewer workers, `maxtasksperchild` of 50–200, and fork or forkserver so workers share the parent's memory.

### Why
- The official 3.13 release notes and a check of the installed interpreter both show the GIL still on by default. Free-threading is an experimental separate build, so the plan's premise is false.
- The parallelism comes from the library's native code releasing the GIL. Two independent analyst benchmarks with Pillow on standard 3.13 had threads matching or beating the process pool. A pure-Python loop got no speedup from threads.
- A tool-run comparison on this resizing workload found far lower peak memory with threads, because the interpreter and library are no longer copied into every worker. The size of the saving depends on how much memory the image buffers take.
- All three analysts reached this position independently, one after changing sides on the memory evidence. The adversarial review found no blocking flaw, only conditions to check.

### Options weighed
1. ✅ Hybrid: a small process pool with a thread pool inside each process: sound with changes. The fallback if thread scaling falls short or some Python-level work remains. Two or three processes, each running a thread pool, keep most of the memory saving and recover throughput and some crash isolation.
2. ❌ Keep multiprocessing.Pool unchanged: unsound. Leaving the pool as it is does nothing for the stated goal of cutting memory.
3. ✅ Replace multiprocessing.Pool with ThreadPoolExecutor: **recommended**
4. ◐ Keep process-based workers but reduce their memory footprint (worker count, maxtasksperchild, start method, chunking/streaming): partly sound. Recycling workers and choosing the start method do trim memory. But the duplicated interpreter and library baseline in every worker stays, and that is where most of the saving comes from.

### Your premises, checked
| Claim | Verdict | Basis |
|---|---|---|
| The GIL is removed in Python 3.13. | ❌ does not hold | Accurate version: The GIL is not removed in Python 3.13. Python 3.13 introduces an experimental, opt-in free-threaded build (accessed via a separate python3.13t executable) in which the GIL can be disabled; |
| On Python 3.13, threads run CPU-bound Python work in parallel across cores, so a thread pool matches a process pool's throughput for CPU-bound tasks. | ❌ does not hold | Accurate version: On the standard (default) Python 3.13 build, the GIL is still enabled (verified via sys._is_gil_enabled() == True and sysconfig Py_GIL_DISABLED == 0 on the installed python3.13.3 on this machine), so a thread pool running CPU-bound pure-Python work does NOT run… |
| Replacing multiprocessing.Pool with ThreadPoolExecutor meaningfully reduces memory usage for this image-resizing workload. | ✅ holds | python3 monitor.py resize_mp.py (in /private/tmp/.../scratchpad/imgtest, run twice): TARGET=resize_mp.py peak_total_rss_bytes=353009664 peak_total_rss_mb=353.0 num_procs_at_peak=10  /  repeat: peak_total_rss_mb=350.9 num_proc / python3 monitor.py resize_tp.py (same environment,… |

### Do these first
- **must change**: If the real job does significant Python-level work per image (metadata, EXIF/ICC handling, numpy glue, custom loops), threads can fall well behind processes. In one test, about 46ms of Python work per image made threads about 47% slower. Benchmark the full job function before switching. If Python work is more than roughly 30% of per-image time, use the hybrid or trimmed processes instead.
- **do first** (verified): Confirm production runs the standard GIL build and do not move to python3.13t for this change. It is experimental, slower on one thread, and some C extensions switch the GIL back on. Library support for the free-threaded build is also uneven: according to the community free-threading compatibility tracker, which two analysts checked, Pillow supports it from 11.0.0, but OpenCV's support is still in progress with no released version. On a free-threaded build, OpenCV would switch the GIL back on or be unsafe. None of this matters on the standard build, where threads rely only on the library releasing the GIL during its C work.
- **do first** (verified): The 3x memory saving was measured with single-colour 1600x1200 test images, by summing per-process RSS on macOS, where workers are spawned. With realistic 12MP photos the saving fell to about 37%. Measure cgroup memory or PSS in the production container, and split it into interpreter baseline and image buffers, before promising a lower memory limit.
- **do alongside**: Cap the number of images in flight at about the core count (semaphore or bounded queue) and set max_workers explicitly. The default (min(32, cores+4)) and unbounded submission let decoded buffers pile up in one process. Decode JPEGs at reduced size with Image.draft() or reduce= when downscaling.
- **do alongside** (verified): The process pool's maxtasksperchild setting restarted workers periodically and cleared native-heap fragmentation. A thread pool has no equivalent. Set MALLOC_ARENA_MAX=2 or use jemalloc, run a multi-day RSS soak test, and have the supervisor recycle the process after N jobs or above an RSS limit.
- **do alongside**: Threads lose process isolation. Shared globals, per-worker clients, temp names built from the process ID and process-wide Pillow settings can start to race. A native decoder crash now takes down every in-flight job. Audit the worker code, validate image dimensions before decoding, make jobs retryable, and keep the Pool path behind a flag.

### Corrections to the premises
- Python 3.13 did not remove the GIL. The default build keeps it. Free-threading is an experimental, opt-in build (python3.13t) that is slower on a single thread, and importing a C extension that doesn't support it turns the GIL back on.
- On the standard 3.13 build, threads do not run Python code in parallel. A pure-Python loop gained nothing from threads. Threads only scale here because the imaging library's C code releases the GIL during decode, resize and encode. How well they keep up with processes depends on how much of each job is Python code.

### Where this could be wrong
- All the throughput benchmarks used bare decode, resize and encode on large images. That is the case most favourable to threads, and the production job may do more Python work.
- Memory figures came from macOS, where workers are spawned. On Linux with fork, or with forkserver from 3.14, and measured by PSS, the gap between processes and threads may be smaller.
- The imaging library is not specified. GIL release was checked in Pillow's source only; for OpenCV and pyvips it comes from memory.
- Free-threaded-build compatibility (Pillow from 11.0.0 yes, OpenCV not yet released) was taken from a community tracker page at one point in time. It only matters if production is, or later moves to, python3.13t, which this verdict advises against.
- **What would change the verdict:** A profile of the production job showing more than about 30% of per-image time in Python code, or a thread-pool benchmark on real images scaling well below the process pool at the same worker count.; Production memory measurements (cgroup or PSS) showing decoded image buffers dominate and the interpreter baseline is small, so threads save little.; The production imaging library turning out not to release the GIL in its resize path, or not being thread-safe.

#### How the council ran
- standard mode; 3 blind seats (Claude Fable, Claude Opus, Claude Sonnet). Blind vote: 2× option 3: Replace multiprocessing.Pool with…, 1× option 4: Keep process-based workers but reduce their…. Final: 3× option 3: Replace multiprocessing.Pool with…. Position changes: 1 on evidence, 0 without evidence (ignored).
- 4 claim(s) checked with tools (2 false, 2 true); red team: withstands with changes; audit: flagged fact attrition, repaired; 17 agents. All voting seats were Claude models, so their agreement is one model family's view.