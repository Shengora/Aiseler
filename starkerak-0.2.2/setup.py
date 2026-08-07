from setuptools import setup, find_packages
import os

# README.md ni o'qib olish
this_directory = os.path.abspath(os.path.dirname(__file__))
with open(os.path.join(this_directory, 'README.md'), encoding='utf-8') as f:
    long_description = f.read()

setup(
    name="starkerak",
    version="0.2.2",
    description="StarKerak To'lov Monitoring API va Websocket Client",
    long_description=long_description,
    long_description_content_type='text/markdown',
    author="StarKerak Jamoasi",
    packages=find_packages(),
    py_modules=["starkerak"],
    install_requires=[
        "aiohttp>=3.8.0"
    ],
    classifiers=[
        "Programming Language :: Python :: 3",
        "License :: OSI Approved :: MIT License",
        "Operating System :: OS Independent",
    ],
    python_requires='>=3.7',
)
