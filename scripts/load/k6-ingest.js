/* global __ENV, __ITER, __VU, open */
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const scenario = __ENV.SCENARIO || 'dup_heavy';
const baseUrl = __ENV.BASE_URL || 'http://127.0.0.1:3000';
const plan = JSON.parse(open('./scripts/load/plan.json'));
const status202 = new Counter('responses_202');
const status200 = new Counter('responses_200');
const status422 = new Counter('responses_422');
const statusErrors = new Counter('responses_errors');

export const options = scenario === 'smoke'
  ? {
      vus: 1,
      iterations: 10,
      thresholds: { checks: ['rate==1'], http_req_failed: ['rate==0'] },
    }
  : scenario === 'same_key_storm'
    ? {
        scenarios: {
          storm: { executor: 'shared-iterations', vus: 1000, iterations: 1000, maxDuration: '2m' },
        },
        thresholds: { checks: ['rate==1'], http_req_failed: ['rate==0'] },
      }
    : {
        // Target rate is configurable and is recorded by the orchestrator in RESULTS.md.
        scenarios: {
          dup_heavy: {
            executor: 'constant-arrival-rate',
            rate: Number(__ENV.ARRIVAL_RATE || 25),
            timeUnit: '1s',
            duration: __ENV.DURATION || '60s',
            preAllocatedVUs: Number(__ENV.PREALLOCATED_VUS || 50),
            maxVUs: Number(__ENV.MAX_VUS || 200),
          },
        },
        thresholds: { checks: ['rate==1'], http_req_failed: ['rate==0'] },
      };

function requestFor(iteration) {
  if (scenario === 'same_key_storm') {
    return { key: 'same-key-storm', body: plan.stormBody };
  }
  if (scenario === 'smoke') return plan.requests[iteration % plan.requests.length];
  return plan.requests[(__ITER + __VU - 1) % plan.requests.length];
}

export default function () {
  const request = requestFor(__ITER);
  const response = http.post(`${baseUrl}/v1/events`, JSON.stringify(request.body), {
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': __ENV.API_KEY || 'change-me',
      'Idempotency-Key': request.key,
    },
  });
  if (response.status === 202) status202.add(1);
  else if (response.status === 200) status200.add(1);
  else if (response.status === 422) status422.add(1);
  else statusErrors.add(1);
  check(response, {
    'status is 200 or 202': (res) => res.status === 200 || res.status === 202,
    'event_id is present': (res) => {
      try { return Boolean(JSON.parse(res.body).event_id); } catch { return false; }
    },
  });
}
