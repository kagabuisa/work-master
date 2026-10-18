#!/usr/bin/env python3
"""Local detached Docker jobs; no model/API calls, app .env or source access."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
from contextlib import contextmanager

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / 'data/erp-benchmark'
COMPOSE = ROOT / 'scripts/erpnext-benchmark/compose.yaml'
VOLUME = Path('/mnt/HC_Volume_107155360')

def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)

def read(path):
    return json.loads(path.read_text())

def write(path, value):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, indent=2) + '\n')
    tmp.chmod(0o600)
    tmp.replace(path)

@contextmanager
def controller_lock():
    STATE.mkdir(parents=True,exist_ok=True)
    STATE.chmod(0o700)
    with (STATE / 'controller.lock').open('a') as lock:
        os.chmod(lock.name,0o600)
        fcntl.flock(lock,fcntl.LOCK_EX)
        yield

def digest():
    hasher = hashlib.sha256()
    files = [ROOT / name for name in ['server.js','package.json','package-lock.json','Dockerfile']]
    for folder in ['src','scripts','public','views','tests']:
        files.extend(p for p in (ROOT / folder).rglob('*') if p.is_file() and '__pycache__' not in p.parts)
    for path in sorted(files):
        hasher.update(str(path.relative_to(ROOT)).encode() + b'\0')
        hasher.update(path.read_bytes())
    return hasher.hexdigest()

def compose(meta, *args, **kwargs):
    config = dict(line.split('=',1) for line in (Path(meta['directory']) / 'config.env').read_text().splitlines() if line)
    for key, expected in [('BENCHMARK_DIRECTORY',meta['directory']),('BENCHMARK_RUN_ID',meta['run_id']),
                          ('BENCHMARK_IMAGE',meta['image']),('BENCHMARK_MODE',meta['mode'])]:
        if config.get(key) != expected:
            raise RuntimeError('Retained benchmark configuration does not match its run manifest.')
    # Shell variables otherwise override --env-file interpolation in Compose.
    # Pin every generated value and ignore inherited Compose project/profile files.
    environment = {key:value for key,value in os.environ.items() if not key.startswith('COMPOSE_')}
    environment.update(config)
    kwargs['env'] = environment
    try:
        return run(['docker','compose','--env-file',str(Path(meta['directory']) / 'config.env'),'-f',meta.get('compose_file',str(COMPOSE)),'-p',meta['project'],*args], **kwargs)
    except subprocess.CalledProcessError as error:
        private = Path(meta['directory']) / 'controller-errors.log'
        with private.open('a') as log:
            os.chmod(log.name,0o600)
            log.write('Compose action: ' + ' '.join(args) + '\n' + (error.stderr or '') + (error.stdout or '') + '\n')
        raise

def load(run_id=None, mode='full'):
    if run_id:
        if not run_id.startswith(('erp-full-','erp-pilot-')) or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-' for c in run_id):
            raise RuntimeError('Invalid run identifier.')
        path = STATE / (run_id + '.json')
    else:
        path = STATE / ('latest-' + mode + '.json')
    if not path.exists():
        raise RuntimeError('No matching benchmark run is recorded.')
    meta = read(path)
    directory = Path(meta['directory'])
    if directory.parent != VOLUME or directory.name != 'wm-' + meta['run_id']:
        raise RuntimeError('Retained run points outside its dedicated volume directory.')
    return meta

def isolation(meta):
    ids = compose(meta,'ps','-a','-q',capture_output=True,text=True).stdout.split()
    if len(ids) != 2:
        raise RuntimeError('Benchmark must contain exactly its own database and job containers.')
    results = []
    for container in ids:
        details = json.loads(run(['docker','inspect',container],capture_output=True,text=True).stdout)[0]
        bindings = details['HostConfig'].get('PortBindings')
        networks = details['NetworkSettings']['Networks']
        if bindings or len(networks) != 1:
            raise RuntimeError('Benchmark isolation failed: unexpected ports or networks.')
        for name in networks:
            internal = run(['docker','network','inspect','--format','{{.Internal}}',name],capture_output=True,text=True).stdout.strip()
            if internal != 'true':
                raise RuntimeError('Benchmark isolation failed: network permits external traffic.')
        names = {value.split('=',1)[0] for value in details['Config']['Env']}
        if any(name.startswith(('ERPNEXT_','OPENAI_')) or name.lower() in ('github_token','github_username') for name in names):
            raise RuntimeError('Benchmark received unexpected source/model credentials.')
        for mount in details['Mounts']:
            if mount['Type'] == 'bind' and not Path(mount['Source']).is_relative_to(Path(meta['directory'])):
                raise RuntimeError('Benchmark mounts files outside its dedicated run directory.')
        results.append({'service':details['Config']['Labels']['com.docker.compose.service'],
                        'no_published_ports':True,'one_internal_network':True,'dedicated_bind_mounts':True,
                        'memory_limit_bytes':details['HostConfig']['Memory'],'nano_cpus':details['HostConfig']['NanoCpus']})
    write(Path(meta['directory']) / 'output/isolation.json',{'passed':True,'containers':results})

def start(mode):
    if not VOLUME.is_mount():
        raise RuntimeError('The dedicated attached volume must be mounted.')
    disk = os.statvfs(VOLUME)
    if disk.f_bavail * disk.f_frsize < (15 if mode == 'full' else 2) * 1024**3:
        raise RuntimeError('Not enough free attached-volume storage for this mode.')
    mem = dict(line.split(':',1) for line in Path('/proc/meminfo').read_text().splitlines())
    if int(mem['MemAvailable'].split()[0]) * 1024 < 1200 * 1024**2:
        raise RuntimeError('At least 1200 MiB available host memory is required before starting.')
    current = digest()
    if mode == 'full':
        pilot = load(mode='pilot')
        status = read(Path(pilot['directory']) / 'output/status.json')
        if status.get('stage') != 'complete' or not status.get('passed') or pilot['source_sha256'] != current:
            raise RuntimeError('A passing pilot on the same source snapshot is required before full generation.')
        runtime = read(Path(pilot['directory']) / 'output/runtime.json')
        if runtime['job_running'] or runtime['job_exit_code'] != 0 or runtime['job_oom_killed']:
            raise RuntimeError('The pilot must finish with exit code zero and no OOM kill.')
        sizing = read(Path(pilot['directory']) / 'output/storage-projection.json')
        if sizing['planning_budget_bytes'] + 6 * 1024**3 >= disk.f_bavail * disk.f_frsize:
            raise RuntimeError('The measured pilot storage projection does not fit with the required reserve.')
    # Only one of our benchmark deployments may consume the shared host at once.
    for pointer in STATE.glob('erp-*.json') if STATE.exists() else []:
        old = read(pointer)
        ids = compose(old,'ps','--status','running','-q','benchmark-job',capture_output=True,text=True).stdout.strip()
        if ids:
            raise RuntimeError('A benchmark job is already running: ' + old['run_id'])
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    run_id = f'erp-{mode}-{stamp}-{secrets.token_hex(2)}'
    directory = VOLUME / ('wm-' + run_id)
    if directory.exists():
        raise RuntimeError('Run directory already exists; it will not be overwritten.')
    # Provision only this new directory; never prune existing Docker/volume data.
    run(['docker','run','--rm','--network','none','--user','0','--entrypoint','sh',
         '--mount',f'type=bind,src={VOLUME},dst=/volume','postgres:16-alpine','-c',
         'mkdir -m 700 "$1" && mkdir -m 700 "$1/output" && chown 1000:1000 "$1" "$1/output"','sh','/volume/' + directory.name],capture_output=True,text=True)
    STATE.mkdir(parents=True,exist_ok=True)
    STATE.chmod(0o700)
    meta = {'run_id':run_id,'directory':str(directory),'project':'wm-' + run_id.lower(),
            'mode':mode,'image':'work-master-erp-benchmark:' + run_id.lower(),'source_sha256':current,
            'created_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat()}
    frozen_compose = directory / 'compose.yaml'
    frozen_compose.write_bytes(COMPOSE.read_bytes())
    frozen_compose.chmod(0o600)
    meta['compose_file'] = str(frozen_compose)
    env = {'BENCHMARK_DIRECTORY':str(directory),'BENCHMARK_MODE':mode,'BENCHMARK_RUN_ID':run_id,
           'BENCHMARK_IMAGE':meta['image'],'BENCHMARK_DB_PASSWORD':secrets.token_urlsafe(32)}
    config = directory / 'config.env'
    config.write_text(''.join(f'{key}={value}\n' for key,value in env.items()))
    config.chmod(0o600)
    logfile = directory / 'build.log'
    with logfile.open('w') as log:
        logfile.chmod(0o600)
        run(['docker','build','--label','io.work_master.erp_benchmark.source_sha256=' + current,'-t',meta['image'],str(ROOT)],stdout=log,stderr=subprocess.STDOUT)
    if digest() != current:
        raise RuntimeError('Source changed during the build. No job started; retain the build directory and retry.')
    meta['image_id'] = run(['docker','image','inspect','--format','{{.Id}}',meta['image']],capture_output=True,text=True).stdout.strip()
    run(['docker','run','--rm','--network','none','--entrypoint','sh',meta['image'],'-c',
         'test ! -e /app/.env && node --check scripts/erpnext-benchmark/job.js'],capture_output=True,text=True)
    write(STATE / (run_id + '.json'),meta)
    write(STATE / ('latest-' + mode + '.json'),meta)
    write(directory / 'output/manifest.json',meta)
    compose(meta,'config','--quiet',capture_output=True,text=True)
    compose(meta,'up','-d',capture_output=True,text=True)
    try:
        isolation(meta)
    except Exception:
        compose(meta,'stop',capture_output=True,text=True)
        raise
    with (directory / 'monitor.log').open('a') as log:
        os.chmod(log.name,0o600)
        subprocess.Popen([sys.executable,str(Path(__file__).resolve()),'monitor','--run',run_id],
                         stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True,close_fds=True)
    print(json.dumps({'started':True,'run_id':run_id,'mode':mode,'output':str(directory / 'output'),
                      'status_command':f'python3 scripts/erpnext-benchmark/control.py status --run {run_id}'},indent=2))

def status(meta):
    path = Path(meta['directory']) / 'output/status.json'
    result = {'run_id':meta['run_id'],'output':str(path.parent),'job':read(path) if path.exists() else {'stage':'starting'}}
    runtime = path.parent / 'runtime.json'
    if runtime.exists(): result['runtime'] = read(runtime)
    raw = compose(meta,'ps','-a','--format','json',capture_output=True,text=True).stdout
    result['containers'] = [json.loads(line) for line in raw.splitlines() if line.strip()]
    # Compose's display includes only generated service names/status/ports; do
    # not inspect or print container environment variables.
    print(json.dumps(result,indent=2))

def use_pilot_image(meta):
    """Adopt a tested immutable image before traffic, preserving the seed DB."""
    output = Path(meta['directory']) / 'output'
    if meta['mode'] != 'full' or (output / 'traffic-started.json').exists():
        raise RuntimeError('A pilot image can only repair full-run seeding before traffic starts.')
    if read(output / 'status.json').get('stage') == 'complete':
        raise RuntimeError('A completed run cannot adopt another image.')
    for pointer in STATE.glob('erp-*.json'):
        other = read(pointer)
        if compose(other,'ps','--status','running','-q','benchmark-job',capture_output=True,text=True).stdout.strip():
            raise RuntimeError('Stop running benchmark jobs before changing a retained image.')
    pilot = load(mode='pilot')
    pilot_output = Path(pilot['directory']) / 'output'
    current = digest()
    result, runtime = read(pilot_output / 'status.json'), read(pilot_output / 'runtime.json')
    if pilot['source_sha256'] != current or result.get('stage') != 'complete' or not result.get('passed'):
        raise RuntimeError('Image repair requires a passing pilot on the current source snapshot.')
    if runtime['job_running'] or runtime['job_exit_code'] != 0 or runtime['job_oom_killed']:
        raise RuntimeError('The replacement pilot must have exited cleanly.')
    actual = run(['docker','image','inspect','--format','{{.Id}}',pilot['image']],capture_output=True,text=True).stdout.strip()
    if actual != pilot['image_id']:
        raise RuntimeError('The passing pilot image has changed.')
    # The same full profile must still describe every retained source key.
    expression = "const p=require('./scripts/erpnext-benchmark/profile');process.stdout.write(p.fingerprint(p.profile('full')))"
    profile = run(['docker','run','--rm','--network','none','--entrypoint','node',pilot['image'],
                   '-e',expression],capture_output=True,text=True).stdout.strip()
    if profile != read(output / 'seed-checkpoint.json')['fingerprint']:
        raise RuntimeError('The replacement image changes the retained data profile; repair refused.')
    # Preserve the failed status and immutable image lineage before replacing
    # the generated image setting. No credentials are copied to the evidence.
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    write(output / ('pre-repair-' + stamp + '.json'),
          {'manifest':meta,'status':read(output / 'status.json'),
           'checkpoint':read(output / 'seed-checkpoint.json')})
    updated = {**meta,'image':pilot['image'],'image_id':actual,'source_sha256':current,
               'image_history':meta.get('image_history',[]) + [
                   {'at_utc':stamp,'previous_image':meta['image'],'previous_image_id':meta['image_id'],
                    'previous_source_sha256':meta['source_sha256'],'replacement_pilot':pilot['run_id']}]}
    config = Path(meta['directory']) / 'config.env'
    lines = config.read_text().splitlines()
    if sum(line.startswith('BENCHMARK_IMAGE=') for line in lines) != 1:
        raise RuntimeError('Expected exactly one retained benchmark image setting.')
    temporary = config.with_suffix('.tmp')
    temporary.write_text('\n'.join('BENCHMARK_IMAGE=' + updated['image'] if line.startswith('BENCHMARK_IMAGE=') else line for line in lines) + '\n')
    temporary.chmod(0o600)
    temporary.replace(config)
    write(STATE / (meta['run_id'] + '.json'),updated)
    latest = STATE / 'latest-full.json'
    if latest.exists() and read(latest)['run_id'] == meta['run_id']: write(latest,updated)
    write(output / 'manifest.json',updated)
    return updated

def monitor(meta):
    output = Path(meta['directory']) / 'output'
    while True:
        ids = compose(meta,'ps','-a','-q',capture_output=True,text=True).stdout.split()
        job_ids = compose(meta,'ps','-a','-q','benchmark-job',capture_output=True,text=True).stdout.split()
        if not job_ids:
            break
        info = json.loads(run(['docker','inspect','--format','{{json .State}}',job_ids[0]],capture_output=True,text=True).stdout)
        if ids:
            raw = run(['docker','stats','--no-stream','--format','{{json .}}',*ids],capture_output=True,text=True).stdout
            sample = {'at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
                      'containers':[json.loads(line) for line in raw.splitlines() if line],
                      'job_running':info['Running'],'job_exit_code':info['ExitCode'],'job_oom_killed':info['OOMKilled']}
            write(output / 'runtime.json',{key:value for key,value in sample.items() if key != 'containers'})
            with (output / 'docker-resources.jsonl').open('a') as log:
                os.chmod(log.name,0o600)
                log.write(json.dumps(sample)+'\n')
        if not info['Running']:
            with controller_lock():
                latest = json.loads(run(['docker','inspect','--format','{{json .State}}',job_ids[0]],capture_output=True,text=True).stdout)
                if not latest['Running']:
                    compose(meta,'stop','benchmark-db',capture_output=True,text=True)
                    break
        time.sleep(15)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['start','status','stop','resume','monitor'])
    parser.add_argument('--pilot',action='store_true')
    parser.add_argument('--run')
    parser.add_argument('--use-pilot-image',action='store_true',
                        help='Resume seeding with the current-source, cleanly passed pilot image; preserve database and image history.')
    args = parser.parse_args()
    if args.use_pilot_image and args.command != 'resume':
        raise RuntimeError('--use-pilot-image is only valid with resume.')
    if args.command == 'start':
        if args.run:
            raise RuntimeError('Start creates a new run; use resume for retained seed progress.')
        start('pilot' if args.pilot else 'full')
        return
    meta = load(args.run,'pilot' if args.pilot else 'full')
    if args.command == 'status': status(meta)
    elif args.command == 'monitor': monitor(meta)
    elif args.command == 'stop':
        compose(meta,'stop',capture_output=True,text=True)
        print('Stopped only the selected benchmark deployment; files and database retained.')
    elif args.command == 'resume':
        if (Path(meta['directory']) / 'output/traffic-started.json').exists():
            raise RuntimeError('Traffic already started; automatic replay is refused. Preserve results and start a new run.')
        actual = run(['docker','image','inspect','--format','{{.Id}}',meta['image']],capture_output=True,text=True).stdout.strip()
        if actual != meta['image_id']:
            raise RuntimeError('Retained benchmark image changed; resume refused.')
        if compose(meta,'ps','--status','running','-q','benchmark-job',capture_output=True,text=True).stdout.strip():
            raise RuntimeError('The selected benchmark job is already running.')
        if args.use_pilot_image: meta = use_pilot_image(meta)
        compose(meta,'up','-d',capture_output=True,text=True)
        isolation(meta)
        with (Path(meta['directory']) / 'monitor.log').open('a') as log:
            subprocess.Popen([sys.executable,str(Path(__file__).resolve()),'monitor','--run',meta['run_id']],
                             stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True,close_fds=True)
        print('Resumed the retained seed from its durable checkpoint; no reset performed.')

if __name__ == '__main__':
    try:
        if len(sys.argv)>1 and sys.argv[1] in ['start','stop','resume']:
            with controller_lock(): main()
        else: main()
    except (RuntimeError,subprocess.CalledProcessError,OSError,ValueError) as error:
        # Never echo command/environment output, which may include private config.
        message = str(error) if isinstance(error,RuntimeError) else type(error).__name__ + ': local benchmark command failed; inspect its private logs.'
        print(message,file=sys.stderr)
        sys.exit(1)
