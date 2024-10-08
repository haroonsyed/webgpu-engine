import { mat4, vec4 } from "gl-matrix";
import { create_gpu_buffer } from "../util/gpu_util";
import { Scene } from "../scene/scene";
import { SystemCore } from "../system/system_core";
import { PipeLine } from "./pipeline";

const DEFAULT_3D_UNIFORM_DATA_SIZE_FLOAT = 4 + 4 * 4 + 4 * 4 + 10 * 4 * 2;
type Default3DLightUniformData = {
  position: vec4; // Includes type in the w channel (unused)
  color: vec4; // Includes intensity in the alpha channel
};
type Default3DUniformData = {
  diffuse_present: GLfloat;
  specular_present: GLfloat;
  normal_present: GLfloat;
  light_count: GLfloat;
  view_matrix: mat4;
  projection_matrix: mat4;
  lights: [
    Default3DLightUniformData,
    Default3DLightUniformData,
    Default3DLightUniformData,
    Default3DLightUniformData,
    Default3DLightUniformData,
    Default3DLightUniformData,
    Default3DLightUniformData,
    Default3DLightUniformData,
    Default3DLightUniformData,
    Default3DLightUniformData
  ];
};

const bind_group_layout_descriptor: GPUBindGroupLayoutDescriptor = {
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      buffer: {
        type: "uniform",
      },
    },
    {
      binding: 1,
      visibility: GPUShaderStage.FRAGMENT,
      sampler: {},
    },
    {
      // Diffuse texture
      binding: 2,
      visibility: GPUShaderStage.FRAGMENT,
      texture: {},
    },
    {
      // Specular texture
      binding: 3,
      visibility: GPUShaderStage.FRAGMENT,
      texture: {},
    },
    {
      // Normal texture
      binding: 4,
      visibility: GPUShaderStage.FRAGMENT,
      texture: {},
    },
    {
      // Model transforms
      binding: 5,
      visibility: GPUShaderStage.VERTEX,
      buffer: {
        type: "read-only-storage",
      },
    },
  ],
};

class Default3DPipeLine extends PipeLine {
  model_transforms: GPUBuffer | undefined;
  uniform_buffer: GPUBuffer | undefined;

  static get_pipeline_label(): string {
    return "default_3d";
  }

  // Necessary to construct asynchonously
  static async construct_pipeline(shader_path: string, scene: Scene) {
    const { shader_manager } = scene;
    const shader = await shader_manager.get_shader(shader_path);

    // Get globals
    const { device } = SystemCore;
    const { presentation_format } = scene;

    // Compile shaders used in this pipeline
    const module = device.createShaderModule({
      code: shader,
    });

    const bind_group_layout = device.createBindGroupLayout(
      bind_group_layout_descriptor
    );
    const pipeline = device.createRenderPipeline({
      label: "default_3d",
      layout: device.createPipelineLayout({
        bindGroupLayouts: [bind_group_layout], // group 0, binding 0
      }),
      vertex: {
        module: module,
        buffers: [
          {
            arrayStride: 16 * 3,
            attributes: [
              {
                shaderLocation: 0, // Position
                offset: 0,
                format: "float32x4",
              },
              {
                shaderLocation: 1, // UV
                offset: 16,
                format: "float32x4",
              },
              {
                shaderLocation: 2, // Normal
                offset: 32,
                format: "float32x4",
              },
            ],
          },
        ],
      },
      fragment: {
        module: module,
        targets: [
          {
            format: presentation_format,
          },
        ],
      },
      primitive: {
        topology: "triangle-list",
      },
      depthStencil: {
        format: "depth24plus",
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });

    const default_3d_pipeline = new Default3DPipeLine(shader_path, pipeline);

    default_3d_pipeline.uniform_buffer = create_gpu_buffer(
      new Float32Array(DEFAULT_3D_UNIFORM_DATA_SIZE_FLOAT),
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    );

    return default_3d_pipeline;
  }

  async render(scene: Scene): Promise<void> {
    const { device, command_encoder } = SystemCore;
    const { texture_manager, texture_view, depth_texture_view } = scene;

    const pipeline_key = Default3DPipeLine.get_pipeline_key(this.shader_path);

    // Get relevant scene objects
    // Potentially slow to filter objects this way
    // Change to store objects in scene structured by pipeline key (and more filters like texture)
    const relevant_scene_objects = scene.objects.filter(
      (object) => object.pipeline_key === pipeline_key
    );

    if (
      relevant_scene_objects.length === 0 ||
      !texture_view ||
      !depth_texture_view
    ) {
      return;
    }

    const render_pass = command_encoder.beginRenderPass({
      colorAttachments: [
        {
          view: texture_view,
          clearValue: [0.0, 0.0, 0.0, 1],
          loadOp: "clear",
          storeOp: "store",
        },
      ],
      depthStencilAttachment: {
        view: depth_texture_view,
        depthClearValue: 1.0,
        stencilClearValue: 0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    render_pass.setPipeline(this.gpu_pipeline as GPURenderPipeline);

    // Get textures
    // For now I will render with same texture
    // I will need to solve this with bindless textures, 2d array, dynamically creating an atlas etc.
    const object_0 = relevant_scene_objects[0];
    const has_texture_diffuse = object_0.has_texture_diffuse() ? 1.0 : 0.0;
    const has_texture_specular = object_0.has_texture_specular() ? 1.0 : 0.0;
    const has_texture_normal = object_0.has_texture_normal() ? 1.0 : 0.0;
    const texture_diffuse = await texture_manager.load_texture(
      object_0.texture_diffuse
    );
    const texture_specular = await texture_manager.load_texture(
      object_0.texture_specular
    );
    const texture_normal = await texture_manager.load_texture(
      object_0.texture_normal
    );

    // Setup the model transforms
    const model_transforms = new Float32Array(
      relevant_scene_objects.flatMap((obj) => [...obj.get_model_matrix()])
    );

    const needed_model_transform_size = relevant_scene_objects.length * 16 * 4;
    const current_model_transforms_size = this.model_transforms?.size ?? 0;

    // Be careful, could lead to a mem leak. Maybe add a 1/2 buffer reduction.
    if (needed_model_transform_size > current_model_transforms_size) {
      this.model_transforms?.destroy();
      this.model_transforms = create_gpu_buffer(
        model_transforms,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      );
    } else {
      // Just write the data
      device.queue.writeBuffer(this.model_transforms!, 0, model_transforms);
    }

    // Setup the uniform data
    const uniform_data = new Float32Array([
      has_texture_diffuse,
      has_texture_specular,
      has_texture_normal,
      scene.lights.length,
      ...scene.camera.get_view_matrix(),
      ...scene.camera.get_projection_matrix(),
      ...scene.lights.reduce(
        (acc, light) => acc.concat([...light.position, 0.0, ...light.color]),
        [] as number[]
      ),
    ]);
    device.queue.writeBuffer(this.uniform_buffer!, 0, uniform_data);

    // Setup bindgroup
    const bindgroup_descriptor: GPUBindGroupDescriptor = {
      layout: this.gpu_pipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: {
            buffer: this.uniform_buffer!,
            offset: 0,
            size: this.uniform_buffer!.size,
          },
        },
        {
          binding: 1,
          resource: device.createSampler({}),
        },
        {
          // Diffuse texture
          binding: 2,
          resource: texture_diffuse.createView(),
        },
        {
          // Specular texture
          binding: 3,
          resource: texture_specular.createView(),
        },
        {
          // Normal texture
          binding: 4,
          resource: texture_normal.createView(),
        },
        {
          // Model transforms
          binding: 5,
          resource: {
            buffer: this.model_transforms!,
            offset: 0,
            size: this.model_transforms!.size,
          },
        },
      ],
    };
    render_pass.setBindGroup(0, device.createBindGroup(bindgroup_descriptor)); // Is this expensive?

    // Render each object
    const { vertex_data_gpu, indices_gpu, index_count } =
      await object_0.get_model_data();
    render_pass.setVertexBuffer(0, vertex_data_gpu);
    render_pass.setIndexBuffer(indices_gpu, "uint32");
    render_pass.drawIndexed(
      index_count,
      relevant_scene_objects.length,
      0,
      0,
      0
    );

    render_pass.end();
  }
}

export { Default3DPipeLine };
