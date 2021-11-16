FROM nearmapltd/ai_general_gpu:latest

USER root

RUN apt-get update && \
    apt-get install -y zsh && \
    chmod -R a+w /opt/conda

USER jovyan

ARG CONDA_TOKEN
ENV CONDA_TOKEN=$CONDA_TOKEN

RUN conda config --prepend channels pytorch && \
    conda config --prepend channels "https://conda.anaconda.org/t/${CONDA_TOKEN}/nearmap"


RUN mamba create -y --name dev python=3.8 "pyaiutils>3" h5py hdf5plugin numexpr pytorch=1.10=py3.8_cuda11.1_cudnn8.0.5_0 torchvision=0.11 cudatoolkit

RUN /opt/conda/envs/dev/bin/python -m pip install tensorflow-gpu==2.5

RUN chmod -R a+w /opt/conda/envs/dev
