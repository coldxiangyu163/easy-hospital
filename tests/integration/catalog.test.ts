import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/server/app.js';
import { openDatabase } from '../../src/storage/database.js';

const expectedDirectory = [
  {
    id: 'hospital-pumch',
    name: '北京协和医院',
    campuses: [
      {
        id: 'campus-pumch-dongdan',
        name: '东单院区',
        departments: [['department-pumch-dermatology', '皮肤科']],
      },
    ],
  },
  {
    id: 'hospital-tongren',
    name: '北京同仁医院',
    campuses: [
      {
        id: 'campus-tongren-chongwenmen',
        name: '崇文门院区',
        departments: [['department-tongren-rhinology', '鼻科']],
      },
    ],
  },
  {
    id: 'hospital-pkuph',
    name: '北京大学人民医院',
    campuses: [
      {
        id: 'campus-pkuph-xizhimen',
        name: '西直门',
        departments: [
          ['department-pkuph-hematology', '血液科'],
          ['department-pkuph-orthopedics', '骨科'],
          ['department-pkuph-breast-surgery', '乳腺外科'],
          ['department-pkuph-gynecology', '妇科'],
          ['department-pkuph-rheumatology-immunology', '风湿免疫科'],
        ],
      },
    ],
  },
  {
    id: 'hospital-puh3',
    name: '北京大学第三医院',
    campuses: [
      {
        id: 'campus-puh3-main',
        name: '院本部',
        departments: [
          ['department-puh3-reproductive-medicine', '生殖医学科'],
          ['department-puh3-sports-medicine', '运动医学科'],
          ['department-puh3-orthopedics', '骨科'],
          ['department-puh3-obstetrics-gynecology', '妇产科'],
          ['department-puh3-gastroenterology', '消化科'],
        ],
      },
    ],
  },
  {
    id: 'hospital-jishuitan',
    name: '北京积水潭医院',
    campuses: [
      {
        id: 'campus-jishuitan-xinjiekou',
        name: '新街口',
        departments: [
          ['department-jishuitan-trauma-orthopedics', '创伤骨科'],
          ['department-jishuitan-hand-surgery', '手外科'],
          ['department-jishuitan-sports-medicine', '运动医学科'],
          ['department-jishuitan-osteoporosis', '骨质疏松科'],
        ],
      },
      {
        id: 'campus-jishuitan-huilongguan',
        name: '回龙观',
        departments: [
          ['department-jishuitan-burn-plastic-wound-repair', '烧伤整形与创面修复科'],
        ],
      },
    ],
  },
  {
    id: 'hospital-fuwai',
    name: '中国医学科学院阜外医院',
    campuses: [
      {
        id: 'campus-fuwai-beilishi',
        name: '北礼士路临床医疗区',
        departments: [
          ['department-fuwai-coronary-heart-disease', '冠心病'],
          ['department-fuwai-arrhythmia', '心律失常'],
          ['department-fuwai-structural-heart-disease', '结构性心脏病'],
          ['department-fuwai-cardiac-surgery', '心脏外科'],
          ['department-fuwai-cardiomyopathy', '心肌病'],
        ],
      },
    ],
  },
  {
    id: 'hospital-anzhen',
    name: '北京安贞医院',
    campuses: [
      {
        id: 'campus-anzhen-chaoyang',
        name: '朝阳院区',
        departments: [
          ['department-anzhen-coronary-heart-disease-center', '冠心病中心'],
          ['department-anzhen-arrhythmia-center', '心律失常中心'],
          ['department-anzhen-cardiac-surgery', '心脏外科'],
          ['department-anzhen-pediatric-heart-center', '小儿心脏中心'],
          ['department-anzhen-vascular-surgery', '血管外科'],
        ],
      },
    ],
  },
  {
    id: 'hospital-pkufh',
    name: '北京大学第一医院',
    campuses: [
      {
        id: 'campus-pkufh-central',
        name: '中心院区',
        departments: [
          ['department-pkufh-dermatology-venereology', '皮肤性病科'],
          ['department-pkufh-urology', '泌尿外科'],
          ['department-pkufh-nephrology', '肾脏内科'],
          ['department-pkufh-neurology', '神经内科'],
        ],
      },
    ],
  },
  {
    id: 'hospital-tiantan',
    name: '北京天坛医院',
    campuses: [
      {
        id: 'campus-tiantan-fengtai',
        name: '丰台院区',
        departments: [
          ['department-tiantan-neurosurgery', '神经外科'],
          ['department-tiantan-neurology', '神经内科'],
          ['department-tiantan-neuro-oncology', '神经肿瘤综合治疗'],
          ['department-tiantan-neurological-rehabilitation', '神经康复'],
        ],
      },
    ],
  },
  {
    id: 'hospital-beijing-childrens',
    name: '北京儿童医院',
    campuses: [
      {
        id: 'campus-beijing-childrens-xicheng',
        name: '西城院区',
        departments: [
          ['department-beijing-childrens-respiratory-medicine', '呼吸科'],
          ['department-beijing-childrens-hematology', '血液病科'],
          ['department-beijing-childrens-otolaryngology-head-neck-surgery', '耳鼻咽喉头颈外科'],
          ['department-beijing-childrens-neurology-center', '神经中心'],
          ['department-beijing-childrens-gastroenterology', '消化科'],
        ],
      },
    ],
  },
  {
    id: 'hospital-cicams',
    name: '中国医学科学院肿瘤医院',
    campuses: [
      {
        id: 'campus-cicams-beijing',
        name: '北京院区',
        departments: [
          ['department-cicams-thoracic-surgery', '胸外科'],
          ['department-cicams-breast-surgery', '乳腺外科'],
          ['department-cicams-colorectal-surgery', '结直肠外科'],
          ['department-cicams-gynecology', '妇科'],
          ['department-cicams-radiation-oncology', '放射治疗科'],
        ],
      },
    ],
  },
] as const;

describe('GET /api/catalog', () => {
  let app: FastifyInstance | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('首次启动 migration 后返回真实目标的 seed 目录', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-catalog-'));
    app = await buildApp({ databasePath: join(directory, 'data.sqlite3') });

    const response = await app.inject({
      method: 'GET',
      url: '/api/catalog',
      headers: { host: '127.0.0.1' },
    });

    expect(response.statusCode).toBe(200);
    const catalog = response.json();
    expect(catalog.hospitals).toHaveLength(11);
    expect(
      catalog.hospitals.map((hospital: { id: string; name: string; campuses: unknown[] }) => ({
        id: hospital.id,
        name: hospital.name,
        campuses: (hospital.campuses as Array<{
          id: string;
          name: string;
          departments: Array<{ id: string; name: string }>;
        }>).map((campus) => ({
          id: campus.id,
          name: campus.name,
          departments: campus.departments.map((department) => [department.id, department.name]),
        })),
      })),
    ).toEqual(expectedDirectory);

    const departments = catalog.hospitals.flatMap(
      (hospital: { campuses: Array<{ departments: unknown[] }> }) =>
        hospital.campuses.flatMap((campus) => campus.departments),
    ) as Array<{
      id: string;
      targetId: string;
      support: {
        active: boolean;
        sortOrder: number;
        supportMode: string;
        canCreateWatchTask: boolean;
      };
    }>;
    expect(departments).toHaveLength(45);
    expect(departments[0]).toMatchObject({
      id: 'department-pumch-dermatology',
      targetId: 'target-pumch-dermatology',
      support: {
        active: true,
        sortOrder: 10,
        supportMode: 'public-source',
        canCreateWatchTask: true,
      },
    });
    expect(departments[1]).toMatchObject({
      id: 'department-tongren-rhinology',
      targetId: 'target-tongren-rhinology',
      support: {
        active: true,
        sortOrder: 10,
        supportMode: 'rules-only',
        canCreateWatchTask: true,
      },
    });
    for (const targetId of [
      'target-anzhen-coronary-heart-disease-center',
      'target-anzhen-arrhythmia-center',
    ]) {
      expect(departments.find((department) => department.targetId === targetId)).toMatchObject({
        support: {
          active: true,
          supportMode: 'public-source',
          canCreateWatchTask: true,
        },
      });
    }
    const supportedTargetIds = new Set([
      'target-pumch-dermatology',
      'target-tongren-rhinology',
      'target-anzhen-coronary-heart-disease-center',
      'target-anzhen-arrhythmia-center',
    ]);
    expect(
      departments
        .filter(({ targetId }) => !supportedTargetIds.has(targetId))
        .every(
          ({ support }) =>
            support.active &&
            support.supportMode === 'directory-only' &&
            !support.canCreateWatchTask,
        ),
    ).toBe(true);
  });

  it('buildApp 初始化后固定 catalog 快照，后续请求不再读取数据库且响应互不污染', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-catalog-snapshot-'));
    const databasePath = join(directory, 'data.sqlite3');
    app = await buildApp({ databasePath });
    const headers = { host: '127.0.0.1' };

    const first = await app.inject({ method: 'GET', url: '/api/catalog', headers });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.hospitals[0].name).toBe('北京协和医院');
    firstBody.hospitals[0].name = '调用方本地篡改';

    const database = openDatabase(databasePath);
    database
      .prepare("UPDATE hospital SET name = '请求期间数据库改动' WHERE id = 'hospital-pumch'")
      .run();
    database.close();

    const second = await app.inject({ method: 'GET', url: '/api/catalog', headers });
    expect(second.statusCode).toBe(200);
    expect(second.json().hospitals[0].name).toBe('北京协和医院');
  });

  it('目录顺序不受名称编辑影响，inactive 历史目标仍可解析但不能创建任务', async () => {
    directory = await mkdtemp(join(tmpdir(), 'easy-hospital-catalog-order-'));
    const databasePath = join(directory, 'data.sqlite3');
    const database = openDatabase(databasePath);
    database.prepare("UPDATE hospital SET name = 'ZZ 历史医院' WHERE id = 'hospital-pumch'").run();
    database
      .prepare("UPDATE department SET active = 0 WHERE id = 'department-pumch-dermatology'")
      .run();
    database.close();
    app = await buildApp({ databasePath, enforceWatchTaskPolicy: true });

    const before = await app.inject({
      method: 'GET',
      url: '/api/catalog',
      headers: { host: '127.0.0.1' },
    });
    const hospitalIds = before.json().hospitals.map(({ id }: { id: string }) => id);
    expect(hospitalIds).toEqual(expectedDirectory.map(({ id }) => id));
    const inactive = before
      .json()
      .hospitals[0].campuses[0].departments.find(
        ({ id }: { id: string }) => id === 'department-pumch-dermatology',
      );
    expect(inactive).toMatchObject({
      name: '皮肤科',
      support: { active: false, canCreateWatchTask: false },
    });

    const task = await app.inject({
      method: 'POST',
      url: '/api/watch-tasks',
      headers: { host: '127.0.0.1' },
      payload: {
        hospitalId: 'hospital-pumch',
        campusId: 'campus-pumch-dongdan',
        departmentId: 'department-pumch-dermatology',
        matchMode: 'any_expert',
        doctorName: null,
        titles: [],
        dateFrom: '2026-07-20',
        dateTo: '2026-07-26',
        session: 'ANY',
        eventTypes: ['schedule_released'],
        remindBeforeMinutes: 5,
      },
    });
    expect(task.statusCode).toBe(400);
    expect(task.json()).toEqual({ error: 'SOURCE_POLICY_VIOLATION' });
  });
});
